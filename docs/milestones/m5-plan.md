# M5 plan — page-image confirmation first

M5's exit test is extraction evals passing on hard-stop fields (master plan). That needs AWS and a clinician, so it cannot finish
yet. This plan covers what comes first and needs neither: a person confirms a hard-stop input against the rendered page (I2, XF-7b).

| Step | Delivers | Needs AWS? |
| --- | --- | --- |
| 1. Render | The worker turns each page into a PNG in a locked-down child process, before OCR. A file it cannot render fails with nothing written (XF-8) | No |
| 2. Show and record (done) | The page image sits beside the fact. `evidence.viewed` fires when the image has loaded in the browser, and only then can the reading be confirmed | No |
| 3. Enforce | Finalize is refused while a `single_source` hard-stop No has not been confirmed against its page (T12) | No |
| Later | Key-aware quote checks; fuzzy quote matching and its two 5.6 metrics, tuned on real Textract output; quote highlights from Textract word positions; the first real eval run | Yes |

Fuzzy matching waits on purpose: tuned without real OCR output it could let fabricated quotes pass (I2).

## Decisions for step 1

- **Dependency.** `pdfjs-dist` (Apache-2.0, founder approved 2026-10-31) in the worker only. On a server it renders through
  `@napi-rs/canvas`, a native package that arrives as its optional dependency, so the file parser runs native code.
- **The child process.** Node's permission flags are not a boundary (persona review of step 1), so on Linux the operating system
  holds it: new user, network and process namespaces, an empty environment, and limits on memory, files and core dumps. The flags
  stay as a second layer. Bytes arrive on stdin, PNGs leave on stdout one at a time, and that output is treated as hostile.
- **Where images live.** `documents/<facility>/<referral>/pages/<sha256>/<n>.png`, inside the prefix the roles already cover, so no
  new IAM. The name comes from the file's hash, so a repeated job writes the same objects.
- **What the browser gets.** Only PNGs, re-encoded by the renderer. The original stays a download (`Get a copy to read`).
- **File types.** PDF, PNG and JPEG render. TIFF does not yet, so a fact on a TIFF cannot be confirmed against an image and a person
  must state it with a note (`shortcut:` until a TIFF decoder is justified).

## Open

Before real patient data or the non-demo deploy: run `unshare` on the demo's AL2023 at first deploy; give page images per-job
credentials (the `compute-roles` worker role has no S3 access of its own).
A corrupt JBIG2 or truncated JPEG can render blank: a person sees an empty page and cannot confirm from it.

`evidence.viewed` now records a page image that loaded in the reviewer's browser (step 2, done). The browser reports it, so a tampered browser could still claim it; sign-in decides who is asking.
Until quote highlights land, a reviewer finds the passage by eye.
