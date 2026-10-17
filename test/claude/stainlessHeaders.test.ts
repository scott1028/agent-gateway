// Bundled Anthropic SDK 0.128.0 header defaults. Copied from the pinned native release 2.1.299
// (SHA256 2d894a4b1bfaaa9a): version constant YT and runtime snapshot te at 218715152, OS/arch
// mappers x/D and the once-cache Djn at 218716552, buildHeaders at 218991503, buildRequest at
// 218990687 (default timeout lands on the COPY, buildHeaders sees the original options),
// makeRequest retryCount at 218985400 and the main client maxRetries:0 at 226673293.
// references/claude-code @9b4f0d6 publishes plugin transport only; SDK evidence comes from
// the pinned native binary above, as documented in docs/CLAUDE_UPSTREAM_PROTOCOL_DIFF.md.
// Snapshot cases mock the process descriptors and re-import the module, so they pass on any
// host; the literal mapping vectors below are validated independently of the host process.
import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_SDK_VERSION } from '../../src/constants.js';
import { buildClaudeHeaders, getClaudeStainlessArch, getClaudeStainlessOs } from '../../src/claude/client.js';

const buildHeaders = () => buildClaudeHeaders({ accessToken: 'at-1' });

// Fresh module instance with patched process descriptors: the platform snapshot is cached
// per module (Djn), so resetModules plus a new import observes the patched values.
const withFreshClient = async (platform: string, arch: string, run: (build: () => Record<string, string>) => void): Promise<void> => {
  const originalPlatform = process.platform;
  const originalArch = process.arch;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  try {
    vi.resetModules();
    const mod = (await import('../../src/claude/client.js')) as typeof import('../../src/claude/client.js');
    run(() => mod.buildClaudeHeaders({ accessToken: 'at-1' }));
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    Object.defineProperty(process, 'arch', { value: originalArch, configurable: true });
    vi.resetModules();
  }
};

describe('SDK version constant', () => {
  it('is the literal bundled SDK version, separate from the CLI version', () => {
    expect(CLAUDE_SDK_VERSION).toBe('0.128.0');
  });
});

describe('stainless platform headers', () => {
  it('sends the six platform headers plus retry count and the browser-access flag', () => {
    const sent = buildHeaders();
    expect(sent['x-stainless-lang']).toBe('js');
    expect(sent['x-stainless-package-version']).toBe('0.128.0');
    // Host-independent: the mapping itself is validated by the literal vectors below, so the
    // snapshot only has to agree with the validated mapper for the real process values.
    expect(sent['x-stainless-os']).toBe(getClaudeStainlessOs(process.platform));
    expect(sent['x-stainless-arch']).toBe(getClaudeStainlessArch(process.arch));
    expect(sent['x-stainless-runtime']).toBe('node');
    expect(sent['x-stainless-runtime-version']).toBe(process.version);
    expect(sent['x-stainless-retry-count']).toBe('0');
    expect(sent['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('wires a macOS/arm64 host to MacOS/arm64 headers without depending on the host', async () => {
    await withFreshClient('darwin', 'arm64', (build) => {
      const sent = build();
      expect(sent['x-stainless-os']).toBe('MacOS');
      expect(sent['x-stainless-arch']).toBe('arm64');
      expect(sent['x-stainless-runtime']).toBe('node');
    });
  });

  it('omits the timeout header unless a truthy timeout was explicitly supplied', () => {
    expect(buildHeaders()['x-stainless-timeout']).toBeUndefined();
    expect(buildClaudeHeaders({ accessToken: 'at-1', timeoutMs: 0 })['x-stainless-timeout']).toBeUndefined();
    expect(buildClaudeHeaders({ accessToken: 'at-1', timeoutMs: 600_000 })['x-stainless-timeout']).toBe('600');
    expect(buildClaudeHeaders({ accessToken: 'at-1', timeoutMs: 1_500 })['x-stainless-timeout']).toBe('1');
    expect(buildClaudeHeaders({ accessToken: 'at-1', timeoutMs: 999 })['x-stainless-timeout']).toBe('0');
  });

  it('maps OS aliases like x() at 218716552', () => {
    expect(getClaudeStainlessOs('linux')).toBe('Linux');
    expect(getClaudeStainlessOs('Linux')).toBe('Linux');
    expect(getClaudeStainlessOs('darwin')).toBe('MacOS');
    expect(getClaudeStainlessOs('win32')).toBe('Windows');
    expect(getClaudeStainlessOs('freebsd')).toBe('FreeBSD');
    expect(getClaudeStainlessOs('openbsd')).toBe('OpenBSD');
    expect(getClaudeStainlessOs('android')).toBe('Android');
    expect(getClaudeStainlessOs('iOS')).toBe('iOS');
    expect(getClaudeStainlessOs('some-ios-variant')).toBe('iOS');
    expect(getClaudeStainlessOs('iphone')).toBe('Other:iphone');
    expect(getClaudeStainlessOs('sunos')).toBe('Other:sunos');
    expect(getClaudeStainlessOs('')).toBe('Unknown');
    expect(getClaudeStainlessOs('unknown')).toBe('Other:unknown');
  });

  it('maps arch aliases like D() at 218716552', () => {
    expect(getClaudeStainlessArch('x64')).toBe('x64');
    expect(getClaudeStainlessArch('x86_64')).toBe('x64');
    expect(getClaudeStainlessArch('arm')).toBe('arm');
    expect(getClaudeStainlessArch('arm64')).toBe('arm64');
    expect(getClaudeStainlessArch('aarch64')).toBe('arm64');
    expect(getClaudeStainlessArch('x32')).toBe('x32');
    expect(getClaudeStainlessArch('ia32')).toBe('other:ia32');
    expect(getClaudeStainlessArch('')).toBe('unknown');
    expect(getClaudeStainlessArch('unknown')).toBe('other:unknown');
    // D() compares case-sensitively and echoes the raw value in the fallback: no lowercase step.
    expect(getClaudeStainlessArch('ARM64')).toBe('other:ARM64');
    expect(getClaudeStainlessArch('X64')).toBe('other:X64');
    expect(getClaudeStainlessArch('MIPS')).toBe('other:MIPS');
  });

  it('keeps the cached platform headers when process.platform changes', async () => {
    await withFreshClient('linux', 'x64', (build) => {
      const first = build();
      Object.defineProperty(process, 'platform', { value: 'sunos', configurable: true });
      try {
        expect(build()['x-stainless-os']).toBe(first['x-stainless-os']);
      } finally {
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      }
    });
  });
});
