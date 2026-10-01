import {
  Address,
  Asset,
  TransactionBuilder,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

import { ASSET_REGISTRY, getAssetIssuer, verifiedAsset } from './assets';
import { normalizeOrigin } from './dappAllowlist';
import { getNetwork } from './network';

export const DAPP_PROVIDER_REQUEST_TYPE = 'veil:provider-request';
export const DAPP_PROVIDER_RESPONSE_EVENT = 'veil:provider-response';

export type DappProviderRequest = {
  type: typeof DAPP_PROVIDER_REQUEST_TYPE;
  id: string;
  method: string;
  origin: string;
  token: string;
  params: Record<string, unknown>;
};

export type DappProviderResponse =
  | { id: string; result: unknown }
  | { id: string; error: { code: string; message: string } };

export type SigningPrompt = {
  origin: string;
  request: 'Sign transaction' | 'Sign auth entry';
  operation: string;
  asset: string;
  amount: string;
};

export type SigningDescription = {
  operation: string;
  asset: string;
  amount: string;
};

export type ProviderDependencies = {
  approvedOrigin: string;
  loadedUrl: string | null;
  sourceUrl: string;
  token: string;
  getAddress: () => Promise<string | null>;
  signXdr: (xdrString: string) => Promise<string>;
  requestApproval: (prompt: SigningPrompt) => Promise<boolean>;
  describeXdr?: (xdrString: string) => SigningDescription | null;
};

function responseError(id: string, code: string, message: string): DappProviderResponse {
  return { id, error: { code, message } };
}

export function parseDappProviderRequest(data: string): DappProviderRequest | null {
  if (typeof data !== 'string') return null;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (parsed.type !== DAPP_PROVIDER_REQUEST_TYPE) return null;
    if (
      typeof parsed.id !== 'string' ||
      !parsed.id ||
      typeof parsed.method !== 'string' ||
      typeof parsed.origin !== 'string' ||
      typeof parsed.token !== 'string' ||
      typeof parsed.params !== 'object' ||
      parsed.params === null ||
      Array.isArray(parsed.params)
    ) {
      return null;
    }
    return {
      type: DAPP_PROVIDER_REQUEST_TYPE,
      id: parsed.id,
      method: parsed.method,
      origin: parsed.origin,
      token: parsed.token,
      params: parsed.params as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

export function requestOriginMatches(
  request: DappProviderRequest,
  approvedOrigin: string,
  loadedUrl: string | null,
  sourceUrl: string,
  token: string,
): boolean {
  if (!token || request.token !== token) return false;
  const claimed = normalizeOrigin(request.origin);
  const loaded = normalizeOrigin(loadedUrl ?? approvedOrigin);
  const source = normalizeOrigin(sourceUrl);
  return (
    claimed !== null &&
    loaded !== null &&
    source !== null &&
    claimed === approvedOrigin &&
    loaded === approvedOrigin &&
    source === approvedOrigin
  );
}

function formatStroops(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 10_000_000n;
  const fraction = (absolute % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function shortAddress(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function labelClassicAsset(asset: Asset): string {
  if (asset.isNative()) return 'XLM';
  const code = asset.getCode();
  const issuer = asset.getIssuer();
  if (!issuer) return code;
  const network = getNetwork().name;
  const registered = verifiedAsset(code, issuer, network);
  return registered
    ? `${registered.code} · ${registered.issuerName}`
    : `${code} · issuer ${shortAddress(issuer)}`;
}

function knownSacLabel(contractId: string): string | null {
  const network = getNetwork().name;
  const passphrase = getNetwork().networkPassphrase;
  try {
    if (Asset.native().contractId(passphrase) === contractId) return 'XLM';
  } catch {}

  for (const asset of Object.values(ASSET_REGISTRY)) {
    const issuer = getAssetIssuer(asset.code, network);
    if (!issuer) continue;
    try {
      if (new Asset(asset.code, issuer).contractId(passphrase) === contractId) {
        return `${asset.code} · ${asset.issuerName}`;
      }
    } catch {}
  }
  return null;
}

/**
 * Derive value-moving metadata from the signed XDR. Page-supplied labels are
 * never trusted. Unknown contracts stay visibly unknown in the approval UI.
 */
export function describeSigningXdr(xdrString: string): SigningDescription | null {
  const network = getNetwork();
  const parsed = TransactionBuilder.fromXDR(xdrString, network.networkPassphrase);
  const tx = 'innerTransaction' in parsed ? parsed.innerTransaction : parsed;

  // A single native prompt must describe the whole thing the user is about to
  // authorise. Multiple operations cannot be reduced to one asset/amount pair
  // without hiding information, so refuse them instead of summarising loosely.
  if (tx.operations.length !== 1) return null;
  const operation = tx.operations[0]!;

  if (operation.type === 'payment') {
    return {
      operation: 'Payment',
      asset: labelClassicAsset(operation.asset),
      amount: operation.amount,
    };
  }

  if (operation.type === 'createAccount') {
    return {
      operation: 'Create account',
      asset: 'XLM',
      amount: operation.startingBalance,
    };
  }

  if (operation.type === 'pathPaymentStrictSend') {
    return {
      operation: 'Path payment (send)',
      asset: labelClassicAsset(operation.sendAsset),
      amount: operation.sendAmount,
    };
  }

  if (operation.type === 'pathPaymentStrictReceive') {
    return {
      operation: 'Path payment (maximum send)',
      asset: labelClassicAsset(operation.sendAsset),
      amount: operation.sendMax,
    };
  }

  if (
    operation.type === 'invokeHostFunction' &&
    operation.func.switch().value ===
      xdr.HostFunctionType.hostFunctionTypeInvokeContract().value
  ) {
    const invocation = operation.func.invokeContract();
    if (invocation.functionName().toString() !== 'transfer') return null;

    const contractId = Address.fromScAddress(invocation.contractAddress()).toString();
    const args = invocation.args();
    const raw = args.length >= 3 ? scValToNative(args[2]!) : null;
    const amount =
      typeof raw === 'bigint'
        ? raw
        : typeof raw === 'number' && Number.isSafeInteger(raw)
          ? BigInt(raw)
          : null;
    if (amount === null || amount < 0n) return null;

    const known = knownSacLabel(contractId);
    return {
      operation: 'Token transfer',
      asset: known ?? `Contract ${shortAddress(contractId)}`,
      amount: known ? formatStroops(amount) : `${amount.toString()} raw units`,
    };
  }

  // Never sign an operation whose effect cannot be represented faithfully in
  // the mandatory native operation/asset/amount review.
  return null;
}

function xdrParam(request: DappProviderRequest): string | null {
  const value = request.params.xdr;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function processDappProviderRequest(
  request: DappProviderRequest,
  deps: ProviderDependencies,
): Promise<DappProviderResponse> {
  if (
    !requestOriginMatches(
      request,
      deps.approvedOrigin,
      deps.loadedUrl,
      deps.sourceUrl,
      deps.token,
    )
  ) {
    return responseError(
      request.id,
      'ORIGIN_MISMATCH',
      'The request origin does not match the loaded dApp.',
    );
  }

  if (request.method === 'requestAddress') {
    const address = await deps.getAddress().catch(() => null);
    return address
      ? { id: request.id, result: { address } }
      : responseError(request.id, 'NO_WALLET', 'No wallet is available on this device.');
  }

  if (request.method !== 'signTransaction' && request.method !== 'signAuthEntry') {
    return responseError(
      request.id,
      'METHOD_NOT_FOUND',
      `Unsupported method: ${request.method}`,
    );
  }

  const xdrString = xdrParam(request);
  if (!xdrString) {
    return responseError(request.id, 'INVALID_PARAMS', 'A transaction XDR string is required.');
  }

  let summary: SigningDescription | null;
  try {
    summary = (deps.describeXdr ?? describeSigningXdr)(xdrString);
  } catch {
    return responseError(
      request.id,
      'INVALID_XDR',
      'Veil could not decode the transaction for review.',
    );
  }
  if (!summary) {
    return responseError(
      request.id,
      'UNREVIEWABLE_TRANSACTION',
      'Veil will not sign a transaction it cannot fully describe.',
    );
  }

  const approved = await deps.requestApproval({
    origin: deps.approvedOrigin,
    request: request.method === 'signTransaction' ? 'Sign transaction' : 'Sign auth entry',
    operation: summary.operation,
    asset: summary.asset,
    amount: summary.amount,
  });

  if (!approved) {
    return responseError(
      request.id,
      'USER_REJECTED',
      'The user rejected the signing request.',
    );
  }

  try {
    const signedXdr = await deps.signXdr(xdrString);
    return { id: request.id, result: { signedXdr } };
  } catch (error) {
    if (error instanceof Error && error.message === 'USER_REJECTED') {
      return responseError(
        request.id,
        'USER_REJECTED',
        'The user rejected the signing request.',
      );
    }
    return responseError(request.id, 'SIGNING_FAILED', 'Veil could not sign this request.');
  }
}

export function providerResponseJavaScript(response: DappProviderResponse): string {
  const serialized = JSON.stringify(response).replace(/</g, '\\u003c');
  return `
(function () {
  window.dispatchEvent(new CustomEvent('${DAPP_PROVIDER_RESPONSE_EVENT}', {
    detail: ${serialized}
  }));
})();
true;
`;
}

/**
 * Inject only in the main frame. The random capability token stays in closure
 * scope and the native postMessage function is captured before page scripts run.
 */
export function buildDappProviderJavaScript(token: string): string {
  const safeToken = JSON.stringify(token);
  return `
(function () {
  if (window.top !== window.self) return true;
  if (window.veil && window.veil.__providerVersion === 1) return true;

  var capability = ${safeToken};
  var nativePost = window.ReactNativeWebView &&
    window.ReactNativeWebView.postMessage &&
    window.ReactNativeWebView.postMessage.bind(window.ReactNativeWebView);
  var stringify = JSON.stringify.bind(JSON);
  var pending = Object.create(null);
  var nextId = 1;

  function request(method, params) {
    return new Promise(function (resolve, reject) {
      if (!nativePost) {
        reject(new Error('Veil native bridge is unavailable'));
        return;
      }
      var id = String(nextId++);
      pending[id] = { resolve: resolve, reject: reject };
      nativePost(stringify({
        type: '${DAPP_PROVIDER_REQUEST_TYPE}',
        id: id,
        method: method,
        origin: window.location.origin,
        token: capability,
        params: params || {}
      }));
    });
  }

  window.addEventListener('${DAPP_PROVIDER_RESPONSE_EVENT}', function (event) {
    var response = event && event.detail;
    if (!response || typeof response.id !== 'string') return;
    var waiter = pending[response.id];
    if (!waiter) return;
    delete pending[response.id];
    if (response.error) {
      var error = new Error(String(response.error.message || 'Veil provider error'));
      error.code = response.error.code;
      waiter.reject(error);
    } else {
      waiter.resolve(response.result);
    }
  });

  var provider = {
    requestAddress: function () { return request('requestAddress', {}); },
    signTransaction: function (xdr) { return request('signTransaction', { xdr: xdr }); },
    signAuthEntry: function (xdr) { return request('signAuthEntry', { xdr: xdr }); }
  };
  Object.defineProperty(provider, '__providerVersion', { value: 1, enumerable: false });
  Object.freeze(provider);
  Object.defineProperty(window, 'veil', {
    value: provider,
    writable: false,
    configurable: false,
    enumerable: true
  });
})();
true;
`;
}
