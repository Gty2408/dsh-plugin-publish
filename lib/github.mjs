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
 * Largest single file the blobs endpoint accepts.
 *
 * GitHub's own limit for an inline blob is 100 MB; the body is base64, so the
 * practical ceiling is a little below that. Checking here turns an opaque API
 * rejection into a message naming the file and the way out.
 */
const MAX_BLOB_BYTES = 40 * 1024 * 1024;

/**
 * Remove any credential from text before it is shown or logged.
 *
 * A GitHub token is a secret with write access to every repository the account
 * can reach, and the failure paths are exactly where one ends up in a message:
 * an API error echoing the request, or a URL that carried the token. Every
 * message this module produces passes through here first.
 *
 * @param text - candidate text.
 * @returns the text with token-shaped substrings replaced.
 */
export function scrubSecrets(text) {
	if (typeof text !== "string") return text;
	return text
		/* A token embedded in an https URL. */
		.replace(/https:\/\/[^@\s/]+@github\.com/gu, "https://<redacted>@github.com")
		/* Classic and fine-grained token shapes. */
		.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/gu, "gh?_<redacted>")
		.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, "github_pat_<redacted>");
}

/**
 * Junk that is never uploaded, whatever the ignore rules say.
 *
 * Checked at every depth, not just the root: a nested `node_modules` is exactly
 * as unwanted as a top-level one.
 */
const NEVER_UPLOAD = new Set([".git", "node_modules", ".DS_Store", "Thumbs.db"]);

/**
 * Convert one gitignore glob into an anchored regular expression.
 *
 * The subset implemented here is the part that decides real repositories: `*`
 * (within a path segment), `?`, and `**` in its leading, trailing and infix
 * forms.
 *
 * @param glob - the pattern, already stripped of its `!` and any trailing `/`.
 * @returns the compiled expression, matched against a `/`-separated path.
 */
export function globToRegExp(glob) {
	let out = "";
	for (let i = 0; i < glob.length; i += 1) {
		const ch = glob[i];
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				const before = i === 0 ? "" : glob[i - 1];
				const after = glob[i + 2];
				const atSegmentStart = before === "" || before === "/";
				/* A leading double-star followed by a slash matches zero or more
				   leading directories; a trailing double-star matches everything
				   below; a bare double-star is just a single-star. */
				if (atSegmentStart && (after === "/" || after === void 0)) {
					if (after === "/") { out += "(?:.*/)?"; i += 2; } else { out += ".*"; i += 1; }
					continue;
				}
				out += "[^/]*";
				i += 1;
				continue;
			}
			out += "[^/]*";
			continue;
		}
		if (ch === "?") { out += "[^/]"; continue; }
		if ("\\^$.|+()[]{}".includes(ch)) { out += `\\${ch}`; continue; }
		out += ch;
	}
	return new RegExp(`^${out}$`, "u");
}

/**
 * Parse the rules in one `.gitignore` file.
 *
 * Comments, blank lines, `!` negation, a trailing `/` (directory-only) and a
 * leading or infix `/` (anchored to this file's directory) are all honoured.
 * Trailing whitespace is dropped, which is what git does for an unescaped run.
 *
 * @param text - the file contents.
 * @returns the parsed rules, in file order.
 */
export function parseGitignore(text) {
	const rules = [];
	for (const raw of String(text).split(/\r?\n/u)) {
		let line = raw;
		if (line.trim() === "" || line.startsWith("#")) continue;

		let negated = false;
		if (line.startsWith("!")) { negated = true; line = line.slice(1); }
		line = line.replace(/\s+$/u, "");
		if (line === "") continue;

		let dirOnly = false;
		if (line.endsWith("/")) { dirOnly = true; line = line.slice(0, -1); }

		/* A slash anywhere but the end anchors the pattern to this directory;
		   without one it matches a basename at any depth. */
		let anchored = line.startsWith("/");
		if (anchored) line = line.slice(1);
		else if (line.includes("/")) anchored = true;
		if (line === "") continue;

		rules.push({
			negated,
			dirOnly,
			pattern: line,
			re: globToRegExp(anchored ? line : `**/${line}`)
		});
	}
	return rules;
}

/**
 * Whether one path is ignored, given the rules gathered from the root down.
 *
 * Later rules win, which is how a nested `.gitignore` overrides its parent and
 * how `!` re-includes a file. A directory is pruned the moment a rule matches
 * it, which mirrors git: a file cannot be re-included while the directory
 * holding it is excluded.
 *
 * @param rules - parsed rules, each carrying the `base` directory it came from.
 * @param relPath - the path to test, relative to the walk root, `/`-separated.
 * @param isDir - whether the path is a directory.
 * @returns true when the path must not be uploaded.
 */
export function isIgnored(rules, relPath, isDir) {
	let ignored = false;
	for (const rule of rules) {
		let target = relPath;
		if (rule.base !== "") {
			if (!target.startsWith(`${rule.base}/`)) continue;
			target = target.slice(rule.base.length + 1);
		}
		if (rule.dirOnly && isDir !== true) continue;
		if (rule.re.test(target)) ignored = !rule.negated;
	}
	return ignored;
}

/**
 * Every file under `dir` that a `git add -A` would stage.
 *
 * The `.gitignore` files met on the way down are read and applied directly
 * rather than by shelling out to `git ls-files`. That is deliberate: this
 * publisher works on a machine with no git installed and on a directory that is
 * not a repository, and those two properties are worth more than an exactly
 * faithful re-implementation of git's own matcher. The subset handled here is
 * documented on {@link parseGitignore}.
 *
 * @param dir - absolute directory to walk.
 * @returns absolute file paths.
 */
export function listFilesRespectingGitignore(dir) {
	const out = [];
	const walk = (current, rel, inherited) => {
		const rules = inherited.slice();
		let text;
		try { text = readFileSync(join(current, ".gitignore"), "utf8"); } catch { text = void 0; }
		if (text !== void 0) {
			for (const rule of parseGitignore(text)) rules.push({ ...rule, base: rel });
		}

		for (const name of readdirSync(current)) {
			if (NEVER_UPLOAD.has(name)) continue;
			const full = join(current, name);
			const childRel = rel === "" ? name : `${rel}/${name}`;
			let isDir = false;
			try { isDir = statSync(full).isDirectory(); } catch { continue; }
			if (isIgnored(rules, childRel, isDir)) continue;
			if (isDir) walk(full, childRel, rules);
			else out.push(full);
		}
	};
	walk(dir, "", []);
	return out;
}

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
	 * Raise an error whose text can never carry the token.
	 *
	 * Every failure this class produces goes through here, so a GitHub message
	 * that happens to echo the request cannot leak the credential into a log.
	 *
	 * @param message - the raw message.
	 * @returns the error to throw.
	 */
	fail(message) {
		return new Error(scrubSecrets(message));
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
		if (!r.ok) throw this.fail(`authentication failed: HTTP ${r.status} ${JSON.stringify(r.json)}`);
		return r.json.login;
	}

	/**
	 * Create a public repository, or reuse the existing one.
	 *
	 * When the repository already exists its description is brought up to date
	 * instead of being left alone. That matters for the update path: the
	 * manifest's description is edited far more often than the repository is
	 * recreated, and a stale line on the repository page is the visible half of
	 * the plugin.
	 *
	 * @param owner - the account the repo belongs to.
	 * @param repo - the repository name.
	 * @param description - the repo description.
	 * @returns `{ created, url, described }`.
	 */
	async ensureRepo(owner, repo, description) {
		const existing = await this.call("GET", `/repos/${owner}/${repo}`);
		if (existing.status === 200) {
			const url = existing.json.html_url;
			const wanted = typeof description === "string" ? description : "";
			if (wanted === "" || existing.json.description === wanted) return { created: false, url, described: false };
			const patched = await this.call("PATCH", `/repos/${owner}/${repo}`, { description: wanted });
			/* A description is cosmetic: failing to update it must not fail a
			   publish whose code has already been decided. */
			return { created: false, url, described: patched.ok };
		}
		const made = await this.call("POST", "/user/repos", {
			name: repo,
			description,
			private: false,
			has_issues: true,
			has_wiki: false,
			has_projects: false,
			auto_init: false
		});
		if (!made.ok) throw this.fail(`could not create the repo: HTTP ${made.status} ${JSON.stringify(made.json)}`);
		return { created: true, url: made.json.html_url, described: true };
	}

	/**
	 * Every file under a directory that should be published.
	 *
	 * `.gitignore` is honoured (see {@link listFilesRespectingGitignore}), so a
	 * build directory or an editor's state is not pushed to a public repository
	 * just because it happens to sit next to the source.
	 *
	 * @param dir - the directory to walk.
	 * @returns absolute file paths.
	 */
	listFiles(dir) {
		return listFilesRespectingGitignore(dir);
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
			if (!seed.ok) throw this.fail(`could not seed the empty repo: HTTP ${seed.status} ${JSON.stringify(seed.json)}`);
			const after = await this.call("GET", `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
			if (after.status !== 200) throw this.fail(`the repo was seeded but branch ${branch} is still unreadable: HTTP ${after.status}`);
			parent = after.json.object?.sha;
		} else {
			throw this.fail(`could not read branch ${branch}: HTTP ${head.status}`);
		}

		const tree = [];
		for (const file of files) {
			const rel = relative(dir, file).split(sep).join("/");
			const content = readFileSync(file);
			/* The blobs endpoint takes the body inline, and GitHub rejects a blob
			   over 100 MB. Failing here names the file; failing in the API would
			   not. */
			if (content.byteLength > MAX_BLOB_BYTES) {
				throw this.fail(`${rel} is ${(content.byteLength / 1024 / 1024).toFixed(1)} MB, over the ${MAX_BLOB_BYTES / 1024 / 1024} MB API limit. Ship a file this large as a release asset, or add it to .gitignore.`);
			}
			const blob = await this.call("POST", `/repos/${owner}/${repo}/git/blobs`, {
				content: content.toString("base64"),
				encoding: "base64"
			});
			if (!blob.ok) throw this.fail(`could not upload ${rel}: HTTP ${blob.status} ${JSON.stringify(blob.json)}`);
			tree.push({ path: rel, mode: "100644", type: "blob", sha: blob.json.sha });
			options.onProgress?.(rel);
		}

		const madeTree = await this.call("POST", `/repos/${owner}/${repo}/git/trees`, { tree });
		if (!madeTree.ok) throw this.fail(`could not build the tree: HTTP ${madeTree.status} ${JSON.stringify(madeTree.json)}`);

		const commit = await this.call("POST", `/repos/${owner}/${repo}/git/commits`, {
			message: options.message ?? "chore: publish plugin",
			tree: madeTree.json.sha,
			parents: parent === void 0 ? [] : [parent]
		});
		if (!commit.ok) throw this.fail(`could not create the commit: HTTP ${commit.status} ${JSON.stringify(commit.json)}`);

		const ref = await this.call("PATCH", `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
			sha: commit.json.sha,
			force: options.force === true
		});
		if (!ref.ok) throw this.fail(`could not update ${branch}: HTTP ${ref.status} ${JSON.stringify(ref.json)}`);

		return { commit: commit.json.sha, files: tree.length };
	}

	/**
	 * Ensure the repository carries `names` as topics, keeping the ones already set.
	 *
	 * The topics endpoint REPLACES the whole list, so writing blindly would
	 * silently drop any topic the user had chosen by hand. The current list is
	 * read first and the two are merged, capped at GitHub's limit of 20.
	 *
	 * @param owner - repo owner.
	 * @param repo - repo name.
	 * @param names - topics that must be present.
	 * @returns the repository's topic list afterwards.
	 */
	async setTopics(owner, repo, names) {
		let existing = [];
		const current = await this.call("GET", `/repos/${owner}/${repo}/topics`);
		if (current.ok && Array.isArray(current.json.names)) existing = current.json.names;

		const merged = [...new Set([...existing, ...names])].slice(0, 20);
		const r = await this.call("PUT", `/repos/${owner}/${repo}/topics`, { names: merged });
		if (!r.ok) throw this.fail(`could not set topics: HTTP ${r.status} ${JSON.stringify(r.json)}`);
		return r.json.names ?? merged;
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