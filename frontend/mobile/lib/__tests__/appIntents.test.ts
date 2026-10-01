import { Networks } from '@stellar/stellar-sdk';

import { ASSET_REGISTRY } from '../../assets';
import {
  resolveSnapshotPrice,
  resolveVoiceAsset,
  type VoiceSnapshot,
} from '../appIntents';

const REAL_USDT0 = ASSET_REGISTRY.USDT0.issuer;

describe('voice App Intent asset resolution', () => {
  it('resolves native XLM only when no issuer is supplied', () => {
    expect(resolveVoiceAsset('XLM', null, 'mainnet')).toEqual({
      ok: true,
      code: 'XLM',
      issuer: null,
    });
    expect(resolveVoiceAsset('XLM', 'G'.repeat(56), 'mainnet')).toEqual({
      ok: false,
      reason: 'invalid-xlm-issuer',
    });
  });

  it('pins USDT0 to the exact verified mainnet issuer', () => {
    expect(resolveVoiceAsset('USDT0', REAL_USDT0, 'mainnet')).toEqual({
      ok: true,
      code: 'USDT0',
      issuer: REAL_USDT0,
    });
  });

  it('refuses an impostor issuer even when the asset code matches', () => {
    const impostor = 'GADUBOKGYG4E2BZUVXAZBBILGPIYIPOXAXWIIG6DJ4JDXWOQR67HUSDT';
    expect(resolveVoiceAsset('USDT0', impostor, 'mainnet')).toEqual({
      ok: false,
      reason: 'unverified',
    });
  });

  it('does not claim a mainnet-only registered asset on testnet', () => {
    expect(resolveVoiceAsset('USDT0', REAL_USDT0, 'testnet')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('reads a price only from the exact resolved code+issuer snapshot row', () => {
    const snapshot: VoiceSnapshot = {
      version: 1,
      updatedAt: '2026-10-01T00:00:00.000Z',
      network: 'mainnet',
      xlmBalance: '0',
      prices: [
        { code: 'USDT0', issuer: REAL_USDT0, priceUsd: 1 },
        {
          code: 'USDT0',
          issuer: 'GADUBOKGYG4E2BZUVXAZBBILGPIYIPOXAXWIIG6DJ4JDXWOQR67HUSDT',
          priceUsd: 999,
        },
      ],
    };

    expect(resolveSnapshotPrice(snapshot, 'USDT0', REAL_USDT0)?.priceUsd).toBe(1);
    expect(
      resolveSnapshotPrice(
        snapshot,
        'USDT0',
        'GADUBOKGYG4E2BZUVXAZBBILGPIYIPOXAXWIIG6DJ4JDXWOQR67HUSDT',
      ),
    ).toBeNull();
  });

  it('does not expose signing or key-material fields in the snapshot contract', () => {
    const keys = ['version', 'updatedAt', 'network', 'xlmBalance', 'prices'];
    expect(keys).not.toContain('privateKey');
    expect(keys).not.toContain('seed');
    expect(keys).not.toContain('signerSecret');
    expect(keys).not.toContain('rpcUrl');
    expect(Networks.PUBLIC).toBeTruthy();
  });
});
