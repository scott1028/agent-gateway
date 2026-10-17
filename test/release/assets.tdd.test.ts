// Project-owned binary distribution; no matching behavior in references/**.
import { expect, it } from 'vitest';
import { getReleaseAssetNames } from '../../scripts/release/utils.js';

it('requires all six binaries and both Linux AppImages for the same version and commit', () => {
  expect(getReleaseAssetNames('v0.1.0-36b38c2').sort()).toEqual([
    'agent-gateway-0.1.0-36b38c2-darwin-arm64',
    'agent-gateway-0.1.0-36b38c2-darwin-x64',
    'agent-gateway-0.1.0-36b38c2-linux-arm64',
    'agent-gateway-0.1.0-36b38c2-linux-arm64.AppImage',
    'agent-gateway-0.1.0-36b38c2-linux-x64',
    'agent-gateway-0.1.0-36b38c2-linux-x64.AppImage',
    'agent-gateway-0.1.0-36b38c2-win32-arm64.exe',
    'agent-gateway-0.1.0-36b38c2-win32-x64.exe',
  ]);
});
