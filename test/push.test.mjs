/**
 * End-to-end proof of the push path, WITHOUT creating a repository.
 *
 * ## Why this test no longer touches GitHub
 *
 * An earlier version published to a real repository to prove the flow worked.
 * That was wrong for three reasons:
 *
 *   1. The `repo` scope cannot delete repositories — that needs `delete_repo` —
 *      so every run left an artifact the user had to remove by hand.
 *   2. A test that writes to a real account is not a test; it is a side effect
 *      with assertions attached.
 *   3. It made `npm test` require network access and a credential, so the suite
 *      could not run offline.
 *
 * The push path is instead proven against a **fake GitHub** that speaks the same
 * REST surface: it records the requests and returns realistic payloads. Every
 * branch of `pushTree` — the empty-repo seed, the blob/tree/commit/ref sequence,
 * the 409 case, error propagation — is exercised, with no account involved.
 *
 * The real network path is verified once, deliberately, by `live-verify.mjs`,
 * which is NOT part of the suite and refuses to run without an explicit flag.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { GitHub, resilientFetch } = await import("../lib/github.mjs");

const failures = [];
const check = (l, ok, d = "") => { if (!ok) failures.push(l); console.log(`${ok ? "PASS" : "FAIL"} ${l}${d ? ` ${d}` : ""}`); };

/**
 * A GitHub stand-in that records calls and answers like the real API.
 *
 * The responses below are copied from real ones observed against the live API,
 * including the two shapes that cost the most time to discover: a brand-new
 * repository reporting its missing branch as 409, and `POST /user/repos`
 * returning 201 with the repository object.
 */
function fakeGitHub(options = {}) {
	const calls = [];
	const state = {
		repoExists: options.repoExists ?? false,
		branchStatus: options.branchStatus ?? 404,
		blobFailAt: options.blobFailAt ?? -1
	};
	let blobCount = 0;

	const handler = async (url, init = {}) => {
		const path = String(url).replace("https://api.github.com", "");
		const method = init.method ?? "GET";
		const body = init.body === void 0 ? void 0 : JSON.parse(init.body);
		calls.push({ method, path, body });

		const json = (status, payload) => new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" }
		});

		if (method === "GET" && path === "/user") return json(200, { login: "probe-user" });

		if (method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(path)) {
			return state.repoExists ? json(200, { html_url: `https://github.com${path}` }) : json(404, { message: "Not Found" });
		}

		if (method === "POST" && path === "/user/repos") {
			state.repoExists = true;
			return json(201, { html_url: `https://github.com/probe-user/${body.name}` });
		}

		if (method === "GET" && /\/git\/ref\/heads\//.test(path)) {
			return state.branchStatus === 200
				? json(200, { object: { sha: "parent-sha" } })
				: json(state.branchStatus, { message: "Git Repository is empty." });
		}

		if (method === "PUT" && /\/contents\//.test(path)) {
			/* Seeding an empty repo creates the default branch. */
			state.branchStatus = 200;
			return json(201, { content: { sha: "seed-sha" } });
		}

		if (method === "POST" && path.endsWith("/git/blobs")) {
			blobCount += 1;
			if (blobCount === state.blobFailAt) return json(422, { message: "Blob rejected" });
			return json(201, { sha: `blob-${blobCount}` });
		}

		if (method === "POST" && path.endsWith("/git/trees")) return json(201, { sha: "tree-sha" });
		if (method === "POST" && path.endsWith("/git/commits")) return json(201, { sha: "commit-sha" });
		if (method === "PATCH" && /\/git\/refs\/heads\//.test(path)) return json(200, { object: { sha: body.sha } });
		if (method === "PUT" && path.endsWith("/topics")) return json(200, { names: body.names });

		return json(404, { message: `unhandled ${method} ${path}` });
	};

	return { calls, handler };
}

/* --- a plugin directory to upload ---------------------------------------- */
const dir = join(tmpdir(), `dsh-fake-push-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, "lib"), { recursive: true });
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "probe", version: "1.0.0" }, null, 2));
writeFileSync(join(dir, "cordis.patch.yml"), "- insert:\n    - id: probe\n      name: probe\n");
writeFileSync(join(dir, "lib/index.js"), "export const name = 'probe';\n");

/** Run a body with `fetch` replaced, restoring it afterwards. */
async function withFake(fake, body) {
	const original = globalThis.fetch;
	globalThis.fetch = (url, init) => fake.handler(url, init);
	try {
		return await body();
	} finally {
		globalThis.fetch = original;
	}
}

/* --- 1. a brand-new repo: seed, then upload ------------------------------ */
{
	const fake = fakeGitHub({ repoExists: false, branchStatus: 409 });
	const gh = new GitHub("fake-token");
	const result = await withFake(fake, async () => {
		const made = await gh.ensureRepo("probe-user", "probe-repo", "A probe.");
		const pushed = await gh.pushTree("probe-user", "probe-repo", dir, { message: "test" });
		return { made, pushed };
	});

	check("the repo is reported as created", result.made.created === true, result.made.url);
	check("a 409 empty-repo is seeded, not treated as an error", fake.calls.some((c) => c.method === "PUT" && c.path.includes("/contents/")), JSON.stringify(fake.calls.map((c) => `${c.method} ${c.path}`).slice(0, 4)));
	check("every file became a blob", result.pushed.files === 3, String(result.pushed.files));
	check("a commit was created", result.pushed.commit === "commit-sha", result.pushed.commit);
	check("the branch was updated", fake.calls.some((c) => c.method === "PATCH" && c.path.includes("/git/refs/heads/main")));
	check("no request was made outside api.github.com", fake.calls.every((c) => c.path.startsWith("/")), "");
}

/* --- 2. an existing repo: no seed, no create ----------------------------- */
{
	const fake = fakeGitHub({ repoExists: true, branchStatus: 200 });
	const gh = new GitHub("fake-token");
	const result = await withFake(fake, async () => {
		const made = await gh.ensureRepo("probe-user", "probe-repo", "A probe.");
		const pushed = await gh.pushTree("probe-user", "probe-repo", dir, {});
		return { made, pushed };
	});

	check("an existing repo is not recreated", result.made.created === false);
	check("no repository was created", !fake.calls.some((c) => c.method === "POST" && c.path === "/user/repos"));
	check("an existing branch is not seeded", !fake.calls.some((c) => c.method === "PUT" && c.path.includes("/contents/")));
}

/* --- 3. a 404 branch also seeds ------------------------------------------ */
{
	const fake = fakeGitHub({ repoExists: true, branchStatus: 404 });
	const gh = new GitHub("fake-token");
	await withFake(fake, () => gh.pushTree("probe-user", "probe-repo", dir, {}));
	check("a 404 branch is seeded too", fake.calls.some((c) => c.method === "PUT" && c.path.includes("/contents/")));
}

/* --- 4. a blob failure propagates with its path -------------------------- */
{
	const fake = fakeGitHub({ repoExists: true, branchStatus: 200, blobFailAt: 2 });
	const gh = new GitHub("fake-token");
	let error;
	try {
		await withFake(fake, () => gh.pushTree("probe-user", "probe-repo", dir, {}));
	} catch (e) { error = e; }
	check("a blob failure throws", error !== void 0, error?.message ?? "no error");
	/* The message must name the file that failed, so a partial upload is
	   diagnosable. Which file lands second is not guaranteed, so assert the
	   message names *a* file rather than one specific name. */
	check("the failure names the file", /could not upload \S+\.(js|json|yml)/.test(String(error?.message ?? "")), String(error?.message).slice(0, 80));
	check("no commit was attempted after the failure", !fake.calls.some((c) => c.path.endsWith("/git/commits")));
}

/* --- 5. topics ----------------------------------------------------------- */
{
	const fake = fakeGitHub();
	const gh = new GitHub("fake-token");
	const names = await withFake(fake, () => gh.setTopics("probe-user", "probe-repo", ["dsh-plugin"]));
	check("topics are sent", names.includes("dsh-plugin"), JSON.stringify(names));
	check("the topic request targets the topics endpoint", fake.calls.some((c) => c.path.endsWith("/topics")));
}

/* --- 6. the retry wrapper ------------------------------------------------ */
{
	let attempts = 0;
	const original = globalThis.fetch;
	globalThis.fetch = async () => {
		attempts += 1;
		if (attempts < 3) {
			const error = new Error("fetch failed");
			error.cause = { code: "ECONNRESET" };
			throw error;
		}
		return new Response("ok");
	};
	try {
		const r = await resilientFetch("https://api.github.com/x");
		check("a reset is retried until it succeeds", attempts === 3 && (await r.text()) === "ok", `attempts=${attempts}`);
	} finally {
		globalThis.fetch = original;
	}

	attempts = 0;
	globalThis.fetch = async () => {
		attempts += 1;
		throw new Error("some permanent failure");
	};
	try {
		await resilientFetch("https://api.github.com/x");
		check("a non-transient error is not retried", false, "did not throw");
	} catch {
		check("a non-transient error is not retried", attempts === 1, `attempts=${attempts}`);
	} finally {
		globalThis.fetch = original;
	}
}

rmSync(dir, { recursive: true, force: true });
console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);