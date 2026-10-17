import { execFileSync, spawnSync } from 'node:child_process';

export const getGithubJson = <T>(endpoint: string): T | undefined => {
  const response = spawnSync('gh', ['api', '--include', endpoint], { encoding: 'utf8' });
  if (response.error) throw response.error;
  if (response.status !== 0) {
    if (/^HTTP\/\S+ 404\b/.test(response.stdout)) return undefined;
    throw new Error(`GitHub read failed: ${response.stderr}`);
  }
  const [, ...body] = response.stdout.split(/\r?\n\r?\n/);
  return JSON.parse(body.join('\n\n')) as T;
};

export const getGithubRelease = (repo: string, tag: string) => {
  const [owner, name] = repo.split('/');
  // Mirrors gh release's pending-tag lookup: GraphQL first, then REST by release ID.
  const response = JSON.parse(execFileSync('gh', [
    'api', 'graphql',
    '-f', 'query=query($owner: String!, $name: String!, $tagName: String!) { repository(owner: $owner, name: $name) { release(tagName: $tagName) { databaseId } } }',
    '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `tagName=${tag}`,
  ], { encoding: 'utf8' })) as { data: { repository: { release: { databaseId: number } | null } } };
  const releaseId = response.data.repository.release?.databaseId;
  if (releaseId === undefined) return undefined;
  const release = getGithubJson<{
    id: number; tag_name: string; draft: boolean; target_commitish: string;
  }>(`repos/${repo}/releases/${releaseId}`);
  if (!release) throw new Error(`Cannot read release ${releaseId}`);
  return release;
};
