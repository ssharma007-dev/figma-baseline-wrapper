# Figma baseline wrapper

Shows a Figma-hosted design image at actual size (1x), on a white page with no margins, so Applitools Autonomous can capture it as a visual baseline.

Without this page, Chrome opens the image in its built-in image viewer, which shrinks it to fit the window and adds a dark background.

## Usage

```
https://ssharma007-dev.github.io/figma-baseline-wrapper/?img=<Figma image link>
```

Get the Figma image link from the Figma REST API (token scope `file_content:read`):

```bash
curl -H "X-Figma-Token: <token>" \
  "https://api.figma.com/v1/images/<fileKey>?ids=<nodeId>&format=png&scale=1"
```

Set the Autonomous viewport width to the Figma frame width. The height can be anything; long designs scroll.
