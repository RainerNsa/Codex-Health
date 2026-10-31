# M5 plan — page-image confirmation first

M5's exit test is extraction evals passing on hard-stop fields (master plan). That needs AWS and a clinician, so it cannot finish
yet. This plan covers what comes first and needs neither: a person confirms a hard-stop input against the rendered page (I2, XF-7b).

| Step | Delivers | Needs AWS? |
| --- | --- | --- |
| 1. Render | The worker turns each page into a PNG in a locked-down child process, before OCR. A file it cannot render fails with nothing written (XF-8) | No |
| 2. Show and record | The page image sits beside the fact. `evidence.viewed` fires when the image has loaded in the browser, and only then can the reading be confirmed | No |
| 3. Enforce | Finalize is refused while a `single_source` hard-stop No has not been confirmed against its page (T12) | No |
| Later | Key-aware quote checks; fuzzy quote matching and its two 5.6 metrics, tuned on real Textract output; quote highlights from Textract word positions; the first real eval run | Yes |

Fuzzy matching waits on purpose: tuned without real OCR output it could let fabricated quotes pass (I2).

## Decisions for step 1

- **Dependency.** `pdfjs-dist` (Apache-2.0, founder approved 2026-10-31) in the worker only. On a server it renders through
  `@napi-rs/canvas`, a native package that arrives as its optional dependency, so the file parser runs native code.
- **The child process.** It starts with an empty environment, so it holds no credentials, under Node's permission model with
  reads limited to the code it needs and no writes, child processes or workers. Bytes arrive on stdin, PNGs leave on stdout.
  It has a time limit, a memory limit and a pixel limit per page. Node 24 does not restrict network access under the permission
  model, so a process that escaped the interpreter could still reach the network; the security review covers this.
- **Where images live.** `documents/<facility>/<referral>/pages/<sha256>/<n>.png`, inside the prefix the roles already cover, so no
  Terraform change. The name comes from the file's hash, so a repeated job writes the same objects.
- **What the browser gets.** Only PNGs, re-encoded by the renderer. The original stays a download (`Get a copy to read`).
- **File types.** PDF, PNG and JPEG render. TIFF does not yet, so a fact on a TIFF cannot be confirmed against an image and a person
  must state it with a note (`shortcut:` until a TIFF decoder is justified).

## Open

Before real patient data (founder ruling 2026-10-31): `evidence.viewed` must record the page actually shown, which step 2 delivers.
Until quote highlights land, a reviewer finds the passage by eye.
