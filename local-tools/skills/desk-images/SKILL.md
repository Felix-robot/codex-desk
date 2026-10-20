---
name: desk-images
description: Generate or edit PNG images through the independent Codex Desk relay tools.
---

Use `desk_tools.image_models` to read the provider's actual image model list, then call `desk_tools.image_generate` with a listed model and the user's image description. Select `gpt-image-1` for a basic check or simple low-cost image when it is listed; preserve a user-specified supported model.

For edits, pass the existing image's absolute path in `editPath`. Files must be in an authorized project or this client's attachments directory. Set `transparent` only when requested. The output is one PNG, 1024×1024 at low quality. Tell the user these limits if their requested output differs.

Return the actual generated local image path with normal Markdown image syntax. Do not read credentials or implement a substitute HTTP request in shell. If a service request times out, do not automatically repeat a paid request; first report the result and check the generated images panel.
