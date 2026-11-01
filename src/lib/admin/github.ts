/**
 * Minimal GitHub client for the /admin panel.
 *
 * The site is a static export with no backend, so the panel writes straight to
 * the repository from the browser: cases.json and the WebP assets go up in one
 * atomic commit via the Git Data API (blobs → tree → commit → ref), and the
 * deploy workflow rebuilds and uploads the site. A failed step therefore never
 * leaves the repo half-updated.
 *
 * Auth is a fine-grained personal access token the user pastes once (scoped to
 * this one repo, Contents: read and write). It lives in localStorage — see the
 * warning shown in the panel.
 */

const API = "https://api.github.com";

export const ADMIN_REPO = {
  owner: process.env.NEXT_PUBLIC_ADMIN_REPO_OWNER || "crptmndd",
  repo: process.env.NEXT_PUBLIC_ADMIN_REPO_NAME || "it-optimization",
  branch: process.env.NEXT_PUBLIC_ADMIN_REPO_BRANCH || "main",
};

export const CASES_JSON_PATH = "content/cases.json";
export const BLOG_JSON_PATH = "content/blog.json";
export const SERVICES_JSON_PATH = "content/service-catalog.json";
export const TOKEN_STORAGE_KEY = "itopt-admin-token";

export interface CommitFile {
  path: string;
  /** Text content (UTF-8). Mutually exclusive with `blob`. */
  text?: string;
  /** Binary content — uploaded as a base64 blob first. */
  blob?: Blob;
}

function repoUrl(suffix: string): string {
  return `${API}/repos/${ADMIN_REPO.owner}/${ADMIN_REPO.repo}${suffix}`;
}

async function gh<T>(token: string, suffix: string, init?: RequestInit): Promise<T> {
  const response = await fetch(repoUrl(suffix), {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(await describeError(response));
  }
  return (await response.json()) as T;
}

/** Turn an API failure into something actionable in Russian. */
async function describeError(response: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await response.json()) as { message?: string };
    detail = body.message ?? "";
  } catch {
    /* non-JSON error body — the status alone will have to do */
  }

  if (response.status === 401) {
    return "Токен не принят (401). Проверь, что он скопирован целиком и не истёк.";
  }
  if (response.status === 403 || response.status === 404) {
    return `Нет доступа к репозиторию ${ADMIN_REPO.owner}/${ADMIN_REPO.repo} (${response.status}). Токен должен быть выдан на этот репозиторий с правом Contents: read and write.`;
  }
  if (response.status === 409 || response.status === 422) {
    return `GitHub отклонил запись (${response.status}${detail ? `: ${detail}` : ""}). Скорее всего в репозиторий что-то закоммитили параллельно — обнови страницу и повтори.`;
  }
  return `GitHub API ${response.status}${detail ? `: ${detail}` : ""}`;
}

/** atob() yields bytes, not characters — decode them as UTF-8 so Cyrillic survives. */
function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function encodeBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Chunked so a multi-hundred-KB image can't blow the argument limit.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export interface RepoState<T> {
  data: T;
  /** Head commit the data was read at — publishing checks the branch hasn't moved. */
  headSha: string;
}

/** Read a content file straight from the branch (never a cached copy of the site). */
export async function readJson<T>(token: string, path: string): Promise<RepoState<T>> {
  const ref = await gh<{ object: { sha: string } }>(
    token,
    `/git/ref/heads/${ADMIN_REPO.branch}`,
  );
  const file = await gh<{ content: string; encoding: string }>(
    token,
    `/contents/${path}?ref=${ADMIN_REPO.branch}`,
  );
  if (file.encoding !== "base64") {
    throw new Error(`Неожиданная кодировка ${path}: ${file.encoding}`);
  }
  return {
    data: JSON.parse(decodeBase64Utf8(file.content)) as T,
    headSha: ref.object.sha,
  };
}

/**
 * Commit files (and optionally delete paths) as a single commit on the branch.
 * `expectedHeadSha` guards against clobbering someone else's push: if the branch
 * has moved since the panel loaded, the update is rejected instead of forced.
 *
 * Returns the new commit SHA.
 */
export async function commitFiles(
  token: string,
  {
    message,
    files,
    deletions = [],
    expectedHeadSha,
  }: {
    message: string;
    files: CommitFile[];
    deletions?: string[];
    expectedHeadSha?: string;
  },
): Promise<string> {
  const ref = await gh<{ object: { sha: string } }>(
    token,
    `/git/ref/heads/${ADMIN_REPO.branch}`,
  );
  const headSha = ref.object.sha;
  if (expectedHeadSha && headSha !== expectedHeadSha) {
    throw new Error(
      "В репозиторий закоммитили изменения, пока панель была открыта. Обнови страницу, чтобы не перезаписать их, и внеси правки заново.",
    );
  }

  const headCommit = await gh<{ tree: { sha: string } }>(
    token,
    `/git/commits/${headSha}`,
  );

  const tree: Array<Record<string, unknown>> = [];
  for (const file of files) {
    if (file.blob) {
      const blob = await gh<{ sha: string }>(token, "/git/blobs", {
        method: "POST",
        body: JSON.stringify({
          content: await encodeBase64(file.blob),
          encoding: "base64",
        }),
      });
      tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
    } else {
      tree.push({
        path: file.path,
        mode: "100644",
        type: "blob",
        content: file.text ?? "",
      });
    }
  }
  for (const path of deletions) {
    tree.push({ path, mode: "100644", type: "blob", sha: null });
  }

  const newTree = await gh<{ sha: string }>(token, "/git/trees", {
    method: "POST",
    body: JSON.stringify({ base_tree: headCommit.tree.sha, tree }),
  });

  const commit = await gh<{ sha: string }>(token, "/git/commits", {
    method: "POST",
    body: JSON.stringify({ message, tree: newTree.sha, parents: [headSha] }),
  });

  await gh(token, `/git/refs/heads/${ADMIN_REPO.branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });

  return commit.sha;
}

/** Where the user can watch the rebuild triggered by their commit. */
export function actionsUrl(): string {
  return `https://github.com/${ADMIN_REPO.owner}/${ADMIN_REPO.repo}/actions`;
}

export function commitUrl(sha: string): string {
  return `https://github.com/${ADMIN_REPO.owner}/${ADMIN_REPO.repo}/commit/${sha}`;
}
