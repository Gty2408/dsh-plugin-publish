# dsh-plugin-publish

One command to publish a DSH plugin to GitHub — creates the repo, uploads the
tree, sets the required topic, and writes the `awesome-dsh-plugin` catalog entry
you submit as a PR.

```sh
npx dsh-plugin-publish            # publish the plugin in the current directory
```

## Why this exists

Publishing a DSH plugin means getting four things right, none of which the
harness does for you:

1. **The manifest shape.** The awesome-list CI rejects any repo whose
   `package.json` declares only `dsh.client` — it requires `dsh.bundle`, plus a
   `cordis.patch.yml` beside it. This is the single most common rejection.
2. **Three identifiers that must agree.** `package.json` `name`,
   `cordis.patch.yml`'s row `name`, and the `__ModuleLoader__.load({ id })` in the
   browser bundle. If they disagree the browser half silently never loads.
3. **The `dsh-plugin` topic.** A hard requirement, checked by CI.
4. **The catalog entry.** A YAML file whose `description.en` must be quoted when
   it contains `: `, or the parser reads it as a nested key.

This tool checks all four before it touches the network, then does the upload.

## What it does

| Step | Detail |
| --- | --- |
| Preflight | Validates manifest, the three identifiers, topic, and tests |
| Auth | GitHub **device flow** — no token to paste, no password shared |
| Create | Creates the public repo (or reuses an existing one) |
| Upload | Pushes the whole tree in one commit, preserving directories |
| Topic | Sets `dsh-plugin` and related topics |
| Catalog | Writes `<owner>__<repo>.yml` for the awesome-list PR |

## Safety rails

- **Dry run by default?** No — but `--dry-run` validates and prints the plan
  without touching the network.
- **Never force-pushes.** If the branch already has commits, it refuses unless
  `--force` is passed, and it shows what would be overwritten first.
- **Never publishes secrets.** Files matching common credential patterns are
  reported and skipped.
- **Token handling.** The device-flow token is written to a `0600` file outside
  the repo and deleted when the run ends. It is never printed.
- **Revocation reminder.** Every run ends by telling you where to revoke access.

## Install

As a CLI:

```sh
npx dsh-plugin-publish --help
```

As a DSH plugin (adds a `/publish-plugin` command inside the harness):

```sh
dsh plugin --profile desktop add github:Gty2408/dsh-plugin-publish
```

## Requirements

- Node.js 20+
- A GitHub account (device flow needs no pre-created token)

## Status

Early. The happy path is tested; see `test/`.

## License

MIT