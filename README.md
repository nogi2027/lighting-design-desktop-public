# Lighting Design Desktop

An offline lighting cue workspace. Import a PDF, choose its scene boundaries,
then add lighting cues and notes beside the script. Scanned pages use bundled
English OCR. No account or hosted service is needed.

Save a portable `.lxshow` file to keep the PDF, cues, notes and text history
together. The app also keeps local recovery copies. **Saved** in the workspace
means saved locally; choose **SHOW → Save show** to update the portable file.

## Run from source

Use Node 24 and pnpm 11.16.0:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

## Check and package

```sh
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:desktop
pnpm pack:mac
```

This is preview software. Review OCR and suggested scenes before creating a show.
The project currently publishes source. Mac packages use ad hoc signing and are
not notarized. Intel Mac, Windows and Linux native validation remains outstanding.

Bundled examples include Macbeth, The Importance of Being Earnest, and a scanned
Macbeth excerpt. Their sources, credits and distribution terms are included in
[examples/README.md](examples/README.md).

This repository contains a clean source snapshot, with no private production
history. It can receive reviewed source updates from the maintained private edition.
Old hosted modules remain where the offline backend shares their implementation;
only the desktop build and commands above are supported here.

## License

App code: [MIT](LICENSE). Dependencies, fonts, OCR data and example texts retain
their own terms. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
