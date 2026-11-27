# Security Policy

Please report suspected vulnerabilities privately through GitHub's security advisory feature for this repository. Do not include API keys, access tokens, private slide content, or provider responses in a public issue.

The converter decodes PNG and JPEG input with Sharp before PPTX export. The lockfile overrides the transitive PptxGenJS `image-size` dependency with the patched 2.2.0 release. The dependency audit requires a clean npm audit report.
