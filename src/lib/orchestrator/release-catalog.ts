const FALLBACK_RELEASES = ["self-hosted/v0.8.0", "self-hosted/v0.7.2", "self-hosted/v0.7.1"] as const;
const RELEASE_PATTERN = /^refs\/tags\/(self-hosted\/v(\d+)\.(\d+)\.(\d+))$/;

type GitHubRef = { ref?: string };

function versionParts(release: string): readonly number[] {
  const match = release.match(/v(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : [0, 0, 0];
}

export function sortOfficialReleases(releases: readonly string[]): string[] {
  return [...new Set(releases)].sort((left, right) => {
    const a = versionParts(left);
    const b = versionParts(right);
    for (let index = 0; index < 3; index += 1) {
      if ((a[index] ?? 0) !== (b[index] ?? 0)) return (b[index] ?? 0) - (a[index] ?? 0);
    }
    return 0;
  });
}

export async function getRecentOfficialReleases(limit = 3): Promise<string[]> {
  try {
    const response = await fetch("https://api.github.com/repos/supabase/supabase/git/matching-refs/tags/self-hosted/v", {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "supabase-manager" },
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const refs = await response.json() as GitHubRef[];
    const releases = refs.flatMap(({ ref }) => {
      const match = ref?.match(RELEASE_PATTERN);
      return match ? [match[1]] : [];
    });
    if (releases.length === 0) throw new Error("No official self-hosted releases were returned");
    return sortOfficialReleases(releases).slice(0, limit);
  } catch {
    return FALLBACK_RELEASES.slice(0, limit);
  }
}

export { FALLBACK_RELEASES };
