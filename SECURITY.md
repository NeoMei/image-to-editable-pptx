# Security Policy

Please report suspected vulnerabilities privately through GitHub's security advisory feature for this repository. Do not include API keys, access tokens, private slide content, or provider responses in a public issue.

The converter accepts only an exact 1280×720 PNG and decodes it with Sharp before PPTX export. It does not accept ICNS, JXL, or HEIF input. As of 2026-08-26, PptxGenJS 4.0.1 transitively depends on `image-size`, whose ICNS/JXL/HEIF parsers have published denial-of-service advisories without a patched npm release. Those parsers are outside this tool's accepted input path; the project will adopt the upstream patched release when one becomes available.
