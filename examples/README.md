# Bundled play examples

The application code is MIT licensed. These play texts retain their own rights
and Project Gutenberg distribution terms; they are not relicensed as app code.

- **Macbeth**, William Shakespeare: Project Gutenberg ebook 1533,
  https://www.gutenberg.org/ebooks/1533
- **The Importance of Being Earnest**, Oscar Wilde: ebook 844,
  https://www.gutenberg.org/ebooks/844

The underlying texts are public domain in the United States. Project Gutenberg
asks users elsewhere to check their local copyright terms. The unchanged UTF-8
sources in `sources/` include each ebook's full license and transcription credits.
Those sources were retrieved on 18 October 2026. `catalog.json` records their
hashes and the generated PDF hashes.

The PDFs are freshly typeset from those texts for testing. The scanned Macbeth
excerpt rasterizes three pages of the generated Macbeth PDF, with no text layer.
It is an OCR example, not a separate transcription or an original historical scan.
The build script in `scripts/build-examples.py` reproduces their layout.
