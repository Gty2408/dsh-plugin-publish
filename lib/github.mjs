/**
 * GitHub access for the publisher: device-flow auth and a one-commit tree push.
 *
 * Two things here are non-obvious and were learned the hard way:
 *
 *  - The Git Data API refuses to create a blob while the repository is empty
 *    ("Git Repository is empty."), so a brand-new repo must be seeded with one
 *    commit through the contents API before blobs can be written.
 *  - `raw.githubusercontent.com` is unreachable from some networks even when
 *    `api.github.com` works, so verification must read blobs through the API
 *    rather than assuming raw access.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";

/** The `gh` CLI's public OAuth app id; using it avoids registering an app. */
const CLIENT_ID = "178c6fc778ccc68e1d6a";
const API = "https://api.github.com";
/** Connection resets are routine on some networks, so every call is retried. */
const RETRIES = 12;
const RETRY_DELAY_MS = 400;
/**
 * Per-attempt timeout.
 *
 * Measured on the network this was written for: a successful request to
 * `github.com` completed in 400-630ms, while a blocked one hung until the
 * timeout. So a short attempt with many retries is far more effective than a
 * long attempt with few — the failure mode is "never connects", not "slow".
 */
const ATTEMPT_TIMEOUT_MS = 6000;

/**
 * Fetch with bounded retries for the transient failures seen in practice:
 * `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, undici's connect timeout, and a plain
 * abort because a connect hung.
 *
 * Every request this module makes is a GET or is safe to repeat, so retrying
 * cannot duplicate work. `github.com` answered roughly one attempt in five on
 * the network this was written for, while `api.github.com` stayed reliable, so
 * a single failure must never abort a publish.
 *
 * @param url - request URL.
 * @param init - fetch options; `signal` and `timeoutMs` are per-attempt.
 * @returns the response.
 */
export async function resilientFetch(url, init = {}) {
	let lastError;
	const attempts = init.retries ?? RETRIES;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			const signal = AbortSignal.timeout(init.timeoutMs ?? ATTEMPT_TIMEOUT_MS);
			return await fetch(url, { ...init, signal });
		} catch (error) {
			lastError = error;
			const code = error?.cause?.code ?? error?.code ?? "";
			const message = String(error?.message ?? "");
			const transient = [
				"ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "EPIPE",
				"UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT"
			].includes(code)
				|| /fetch failed/i.test(message)
				|| /aborted due to timeout/i.test(message)
				|| error?.name === "TimeoutError";
			if (!transient || attempt === attempts - 1) break;
			await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * Math.min(attempt + 1, 5)));
		}
	}
	throw lastError;
}

/**
 * Run the GitHub device flow: print a code, wait for the user to authorize.
 *
 * @param options - `scope`, `intervalMs`, `timeoutMs`, and an `onCode` callback
 *   so the caller can present the code before polling begins.
 * @returns the access token.
 */
export async function deviceAuth(options = {}) {
	const scope = options.scope ?? "repo";
	const intervalMs = options.intervalMs ?? 5000;
	const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;

	const startRes = await resilientFetch("https://github.com/login/device/code", {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify({ client_id: CLIENT_ID, scope })
	});
	if (!startRes.ok) throw new Error(`device flow start failed: HTTP ${startRes.status}`);
	const start = await startRes.json();

	options.onCode?.({ userCode: start.user_code, verificationUri: start.verification_uri, expiresIn: start.expires_in });

	const began = Date.now();
	while (Date.now() - began < timeoutMs) {
		await new Promise((r) => setTimeout(r, intervalMs));
		const r = await resilientFetch("https://github.com/login/oauth/access_token", {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({
				client_id: CLIENT_ID,
				device_code: start.device_code,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code"
			})
		});
		const j = await r.json();
		if (typeof j.access_token === "string") return j.access_token;
		if (j.error === "authorization_pending") continue;
		if (j.error === "slow_down") { await new Promise((r2) => setTimeout(r2, intervalMs)); continue; }
		if (j.error === "expired_token") throw new Error("the device code expired before it was authorized");
		if (j.error === "access_denied") throw new Error("authorization was denied");
		throw new Error(`device flow failed: ${j.error ?? "unknown"}`);
	}
	throw new Error("timed out waiting for authorization");
}

/** A thin authenticated GitHub API client. */
export class GitHub {
	/**
	 * @param token - a personal access token or device-flow token.
	 */
	constructor(token) {
		this.token = token;
	}

	/**
	 * Call the API.
	 * @param method - HTTP method.
	 * @param path - path beginning with `/`.
	 * @param body - optional JSON body.
	 * @returns `{ status, ok, json }`.
	 */
	async call(method, path, body) {
		const r = await resilientFetch(`${API}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${this.token}`,
				accept: "application/vnd.github+json",
				"user-agent": "dsh-plugin-publish",
				"x-github-api-version": "2022-11-28",
				...(body === void 0 ? {} : { "content-type": "application/json" })
			},
			body: body === void 0 ? void 0 : JSON.stringify(body)
		});
		const text = await r.text();
		let json;
		try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
		return { status: r.status, ok: r.ok, json };
	}

	/** The authenticated user's login. */
	async whoami() {
		const r = await this.call("GET", "/user");
		if (!r.ok) throw new Error(`authentication failed: HTTP ${r.status} ${JSON.stringify(r.json)}`);
		return r.json.login;
	}

	/**
	 * Create a public repository, or return the existing one.
	 * @param owner - the account the repo belongs to.
	 * @param repo - the repository name.
	 * @param description - the repo description.
	 * @returns `{ created, url }`.
	 */
	async ensureRepo(owner, repo, description) {
		const existing = await this.call("GET", `/repos/${owner}/${repo}`);
		if (existing.status === 200) return { created: false, url: existing.json.html_url };
		const made = await this.call("POST", "/user/repos", {
			name: repo,
			description,
			private: false,
			has_issues: true,
			has_wiki: false,
			has_projects: false,
			auto_init: false
		});
		if (!made.ok) throw new Error(`could not create the repo: HTTP ${made.status} ${JSON.stringify(made.json)}`);
		return { created: true, url: made.json.html_url };
	}

	/** Every file under a directory, with `/`-separated relative paths. */
	listFiles(dir) {
		const out = [];
		const walk = (d) => {
			for (const name of readdirSync(d)) {
				if (name === "node_modules" || name === ".git") continue;
				const full = join(d, name);
				if (statSync(full).isDirectory()) walk(full);
				else out.push(full);
			}
		};
		walk(dir);
		return out;
	}

	/**
	 * Push a directory as one commit.
	 *
	 * @param owner - repo owner.
	 * @param repo - repo name.
	 * @param dir - the directory to publish.
	 * @param options - `message`, `branch`, and `onProgress`.
	 * @returns `{ commit, files }`.
	 */
	async pushTree(owner, repo, dir, options = {}) {
		const branch = options.branch ?? "main";
		const files = this.listFiles(dir);

		/* Seed an empty repo: the Git Data API cannot write blobs into one. A
		   brand-new repo reports its missing branch as 404 or 409 ("Git
		   Repository is empty") depending on timing, so both mean "seed it". */
		const head = await this.call("GET", `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
		let parent;
		if (head.status === 200) {
			parent = head.json.object.sha;
		} else if (head.status === 404 || head.status === 409) {
			const seed = await this.call("PUT", `/repos/${owner}/${repo}/contents/.gitignore`, {
				message: "chore: initialize repository",
				content: Buffer.from("node_modules/\n*.tgz\n.DS_Store\n", "utf8").toString("base64")
			});
			if (!seed.ok) throw new Error(`could not seed the empty repo: HTTP ${seed.status} ${JSON.stringify(seed.json)}`);
			const after = await this.call("GET", `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
			if (after.status !== 200) throw new Error(`the repo was seeded but branch ${branch} is still unreadable: HTTP ${after.status}`);
			parent = after.json.object?.sha;
		} else {
			throw new Error(`could not read branch ${branch}: HTTP ${head.status}`);
		}

		const tree = [];
		for (const file of files) {
			const rel = relative(dir, file).split(sep).join("/");
			const blob = await this.call("POST", `/repos/${owner}/${repo}/git/blobs`, {
				content: readFileSync(file).toString("base64"),
				encoding: "base64"
			});
			if (!blob.ok) throw new Error(`could not upload ${rel}: HTTP ${blob.status} ${JSON.stringify(blob.json)}`);
			tree.push({ path: rel, mode: "100644", type: "blob", sha: blob.json.sha });
			options.onProgress?.(rel);
		}

		const madeTree = await this.call("POST", `/repos/${owner}/${repo}/git/trees`, { tree });
		if (!madeTree.ok) throw new Error(`could not build the tree: HTTP ${madeTree.status} ${JSON.stringify(madeTree.json)}`);

		const commit = await this.call("POST", `/repos/${owner}/${repo}/git/commits`, {
			message: options.message ?? "chore: publish plugin",
			tree: madeTree.json.sha,
			parents: parent === void 0 ? [] : [parent]
		});
		if (!commit.ok) throw new Error(`could not create the commit: HTTP ${commit.status} ${JSON.stringify(commit.json)}`);

		const ref = await this.call("PATCH", `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
			sha: commit.json.sha,
			force: options.force === true
		});
		if (!ref.ok) throw new Error(`could not update ${branch}: HTTP ${ref.status} ${JSON.stringify(ref.json)}`);

		return { commit: commit.json.sha, files: tree.length };
	}

	/**
	 * Replace the repository's topic list.
	 * @param owner - repo owner.
	 * @param repo - repo name.
	 * @param names - topic names.
	 */
	async setTopics(owner, repo, names) {
		const r = await this.call("PUT", `/repos/${owner}/${repo}/topics`, { names });
		if (!r.ok) throw new Error(`could not set topics: HTTP ${r.status} ${JSON.stringify(r.json)}`);
		return r.json.names ?? names;
	}

	/** Read one file's text through the API, without raw.githubusercontent.com. */
	async fileText(owner, repo, path, ref = "main") {
		const r = await this.call("GET", `/repos/${owner}/${repo}/contents/${path}?ref=${ref}`);
		if (!r.ok) return void 0;
		return Buffer.from(r.json.content, "base64").toString("utf8");
	}
}

/**
 * Write a token to a `0600` file outside any repo.
 *
 * Tokens must not be printed or committed; a short-lived file is the least-bad
 * handoff between the auth step and the upload step.
 * @param token - the token.
 * @returns the file path.
 */
export function stashToken(token) {
	const path = join(tmpdir(), `dsh-plugin-publish-token-${process.pid}`);
	writeFileSync(path, token, { mode: 0o600 });
	return path;
}

/** Delete a stashed token. */
export function dropToken(path) {
	try { rmSync(path, { force: true }); } catch { /* already gone */ }
}