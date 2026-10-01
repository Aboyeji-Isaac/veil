import {
  DAPP_PROVIDER_REQUEST_TYPE,
  buildDappProviderJavaScript,
  parseDappProviderRequest,
  processDappProviderRequest,
} from '../dappProvider';

const ORIGIN = 'https://app.soroswap.finance';
const TOKEN = 'capability-test-token';

function request(method: string, origin = ORIGIN) {
  return {
    type: DAPP_PROVIDER_REQUEST_TYPE,
    id: '1',
    method,
    origin,
    token: TOKEN,
    params: { xdr: 'AAAA-test-xdr' },
  } as const;
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    approvedOrigin: ORIGIN,
    loadedUrl: ORIGIN + '/swap',
    sourceUrl: ORIGIN + '/frame-source',
    token: TOKEN,
    getAddress: jest.fn(async () => 'C'.repeat(56)),
    signXdr: jest.fn(async () => 'SIGNED'),
    requestApproval: jest.fn(async () => true),
    describeXdr: jest.fn(() => ({ asset: 'USDC · Circle', amount: '10' })),
    ...overrides,
  };
}

describe('dApp provider boundary', () => {
  it('rejects an origin mismatch before approval or signing', async () => {
    const d = deps();
    const response = await processDappProviderRequest(
      request('signTransaction', 'https://evil.example'),
      d,
    );

    expect('error' in response && response.error.code).toBe('ORIGIN_MISMATCH');
    expect(d.requestApproval).not.toHaveBeenCalled();
    expect(d.signXdr).not.toHaveBeenCalled();
  });

  it('rejects a frame whose native source URL is not the loaded origin', async () => {
    const d = deps({ sourceUrl: 'https://evil.example/frame' });
    const response = await processDappProviderRequest(request('signTransaction'), d);

    expect('error' in response && response.error.code).toBe('ORIGIN_MISMATCH');
    expect(d.signXdr).not.toHaveBeenCalled();
  });

  it('rejects an unknown method cleanly', async () => {
    const d = deps();
    const response = await processDappProviderRequest(request('getPrivateKey'), d);

    expect('error' in response && response.error.code).toBe('METHOD_NOT_FOUND');
    expect(d.requestApproval).not.toHaveBeenCalled();
    expect(d.signXdr).not.toHaveBeenCalled();
  });

  it('leaves signing untouched when the user rejects', async () => {
    const d = deps({ requestApproval: jest.fn(async () => false) });
    const response = await processDappProviderRequest(request('signTransaction'), d);

    expect('error' in response && response.error.code).toBe('USER_REJECTED');
    expect(d.signXdr).not.toHaveBeenCalled();
  });

  it('returns only the public wallet address without signing', async () => {
    const d = deps();
    const response = await processDappProviderRequest(
      { ...request('requestAddress'), params: {} },
      d,
    );

    expect(response).toEqual({ id: '1', result: { address: 'C'.repeat(56) } });
    expect(d.requestApproval).not.toHaveBeenCalled();
    expect(d.signXdr).not.toHaveBeenCalled();
  });

  it('approves before routing signing through the existing XDR signer', async () => {
    const order: string[] = [];
    const d = deps({
      requestApproval: jest.fn(async () => {
        order.push('approval');
        return true;
      }),
      signXdr: jest.fn(async () => {
        order.push('sign');
        return 'SIGNED';
      }),
    });

    const response = await processDappProviderRequest(request('signAuthEntry'), d);

    expect(order).toEqual(['approval', 'sign']);
    expect(response).toEqual({ id: '1', result: { signedXdr: 'SIGNED' } });
  });

  it('injects only the three public provider methods and keeps the capability private', () => {
    const script = buildDappProviderJavaScript(TOKEN);
    expect(script).toContain('requestAddress');
    expect(script).toContain('signTransaction');
    expect(script).toContain('signAuthEntry');
    expect(script).not.toContain('getPrivateKey');
    expect(script).not.toContain('getSignerSecret');
    expect(script).toContain('window.top !== window.self');
    expect(script).toContain(TOKEN);
  });

  it('parses only provider request envelopes', () => {
    expect(
      parseDappProviderRequest(JSON.stringify(request('requestAddress')))?.method,
    ).toBe('requestAddress');
    expect(parseDappProviderRequest(JSON.stringify({ type: 'other' }))).toBeNull();
    expect(parseDappProviderRequest('bad json')).toBeNull();
  });
});
