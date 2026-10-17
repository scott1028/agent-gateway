export const getReleaseMetadata = ({ eventName, ref, defaultBranch, version, previousVersion, sha }: {
  eventName: string;
  ref: string;
  defaultBranch: string;
  version: string;
  previousVersion?: string;
  sha: string;
}) => {
  if (!/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/.test(version)) {
    throw new Error('Invalid package version');
  }
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid commit SHA');
  const tag = `v${version}-${sha.slice(0, 7)}`;
  return {
    shouldRelease: eventName === 'workflow_dispatch' || (
      eventName === 'push' && ref === `refs/heads/${defaultBranch}`
      && previousVersion !== undefined && previousVersion !== version
    ),
    tag,
    name: `agent-gateway ${tag}`,
    version,
    sha,
  };
};

export const getReleaseAssetNames = (tag: string): string[] =>
  ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64.exe', 'win32-arm64.exe', 'linux-x64.AppImage', 'linux-arm64.AppImage']
    .map((platform) => `agent-gateway-${tag.slice(1)}-${platform}`).sort();
