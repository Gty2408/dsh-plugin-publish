/**
 * The token must never reach a message, a log, or an error.
 *
 * A GitHub token has write access to every repository the account can reach, and
 * the failure paths are exactly where one ends up in text: an API error echoing
 * the request, or a URL that carried it. `scrubSecrets` is the single place that
 * removes it, and this pins its behaviour.
 *
 * ## Why the samples are built, not written
 *
 * GitHub's secret scanning rejects a push whose content contains a
 * token-shaped literal — correctly, because a real token in a public repository
 * is compromised the moment it lands. An earlier version of this file pasted a
 * live token in as a test fixture and the push was blocked with
 * "Secret detected in content".
 *
 * So every sample here is assembled at runtime from fragments that are inert on
 * their own. The scrubbing is exercised exactly as before; nothing in the file is
 * a credential, and the file can be published safely.
 */
const { scrubSecrets, GitHub } = await import("../lib/github.mjs");

const failures = [];
const check = (l, ok, d = "") => { if (!ok) failures.push(l); console.log(`${ok ? "PASS" : "FAIL"} ${l}${d ? ` ${d}` : ""}`); };

/**
 * Build a token-shaped string from fragments.
 * @param prefix - the scheme prefix.
 * @param body - the payload.
 * @returns the assembled string.
 */
const make = (prefix, body) => `${prefix}${body}`;

/** A long, high-entropy-looking payload that is not a real credential. */
const PAYLOAD = ["Ab3", "xY9", "Qw7", "Zt2", "Lm5", "Rd8", "Kp4", "Vn6"].join("");

/* --- the shapes a real token takes --------------------------------------- */
const SAMPLES = [
	["classic ghp_", make("ghp_", PAYLOAD)],
	["classic gho_", make("gho_", PAYLOAD)],
	["classic ghs_", make("ghs_", PAYLOAD)],
	["classic ghr_", make("ghr_", PAYLOAD)],
	["classic ghu_", make("ghu_", PAYLOAD)],
	["fine-grained", make("github_pat_", `${PAYLOAD}_${PAYLOAD}`)]
];

for (const [label, token] of SAMPLES) {
	const scrubbed = scrubSecrets(`request failed with ${token} attached`);
	check(`${label} is removed`, !scrubbed.includes(token), scrubbed.slice(0, 70));
	check(`${label} leaves a marker`, scrubbed.includes("<redacted>"), scrubbed.slice(0, 70));
}

/* --- a token embedded in a URL ------------------------------------------- */
{
	const token = make("ghp_", PAYLOAD);
	const url = `https://${token}@github.com/Gty2408/dsh-demo.git`;
	const scrubbed = scrubSecrets(`fatal: could not read from ${url}`);
	check("a token in a URL is removed", !scrubbed.includes(token), scrubbed);
	check("the URL shape is kept readable", scrubbed.includes("https://<redacted>@github.com"), scrubbed);
}

/* --- ordinary text is untouched ------------------------------------------ */
{
	const text = "could not upload lib/index.js: HTTP 422 {\"message\":\"Blob rejected\"}";
	check("ordinary text passes through unchanged", scrubSecrets(text) === text);
	check("a non-string passes through", scrubSecrets(void 0) === void 0);
	check("the word 'token' alone is not mangled", scrubSecrets("no token configured") === "no token configured");
	/* A short string after the prefix is not a token shape and must survive. */
	check("a short ghp_ fragment is left alone", scrubSecrets("ghp_abc") === "ghp_abc", scrubSecrets("ghp_abc"));
}

/* --- the client scrubs everything it throws ------------------------------ */
{
	/* A fake API whose error body echoes the request, which is the realistic way
	   a credential ends up in a message. */
	const token = make("ghp_", PAYLOAD);
	const original = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({
		message: `Bad credentials for ${token}`,
		errors: [{ message: `sent ${token}` }]
	}), { status: 401, headers: { "content-type": "application/json" } });

	try {
		const gh = new GitHub(token);
		let error;
		try { await gh.whoami(); } catch (e) { error = e; }
		check("whoami throws on a bad token", error !== void 0);
		check("the thrown message has no token", !String(error?.message ?? "").includes(token), String(error?.message).slice(0, 90));
	} finally {
		globalThis.fetch = original;
	}
}
{
	const token = make("ghp_", PAYLOAD);
	const original = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({ message: `nope ${token}` }), {
		status: 422, headers: { "content-type": "application/json" }
	});
	try {
		const gh = new GitHub(token);
		let error;
		try { await gh.ensureRepo("a", "b", "d"); } catch (e) { error = e; }
		check("ensureRepo scrubs its failure", !String(error?.message ?? "").includes(token), String(error?.message).slice(0, 90));
	} finally {
		globalThis.fetch = original;
	}
}
{
	/* pushTree is the longest path and reports per-file failures. */
	const token = make("ghp_", PAYLOAD);
	const original = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		const path = String(url).replace("https://api.github.com", "");
		if (path.endsWith("/git/ref/heads/main")) return new Response(JSON.stringify({ object: { sha: "p" } }), { status: 200 });
		if (path.endsWith("/git/blobs")) return new Response(JSON.stringify({ message: `rejected ${token}` }), { status: 422 });
		return new Response("{}", { status: 200 });
	};
	try {
		const gh = new GitHub(token);
		let error;
		try { await gh.pushTree("a", "b", "C:/Users/gty/Documents/deepseek-harness/default-workspace/dsh-plugin-publish", {}); } catch (e) { error = e; }
		check("pushTree scrubs its failure", error !== void 0 && !String(error.message).includes(token), String(error?.message).slice(0, 90));
	} finally {
		globalThis.fetch = original;
	}
}

console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);