# Figma baseline wrapper

Turns a Figma frame into one link that Applitools Autonomous can capture as a visual baseline, so a live website can be compared against the Figma design.

## Why use this instead of the Figma API directly

- The Figma API gives an image link, and Autonomous needs a web page to capture, so this page wraps that image.
- Opened on its own, the Figma image is shrunk by Chrome and shown on a dark background; this page shows it at actual size on a plain page.
- With this page, only the viewport width has to match the frame; the height can be anything, because the page scrolls.
- The Figma API returns the image and the design elements separately; this page combines both into one link.
- The design elements become a real DOM under the image, so the Figma baseline has a DOM like a live website does.
- No one has to write code or call the API by hand; paste a frame link and a token, and copy the result.
- Figma errors (wrong token, missing frame, rate limit) are explained in plain words, not as raw error codes.
- Nothing is stored; the token goes only from your browser to Figma, and never into the link.

## Create a baseline link

Open **https://ssharma007-dev.github.io/figma-baseline-wrapper/make/**, paste:

1. the Figma frame link (select the frame in Figma, copy the browser address; it contains `node-id=`)
2. a Figma personal access token with the `file_content:read` scope

and click **Create baseline link**. The token is sent only to Figma, from your browser, and is never added to the link.

## What the link contains

```
https://ssharma007-dev.github.io/figma-baseline-wrapper/?img=<Figma image link>#dom=<packed design elements>
```

- `img`: the frame exported by Figma as a PNG at 1x. The page shows it at actual size, so the screenshot is pixel-identical to the design. (Chrome on its own would shrink it and add a dark background.)
- `dom`: the frame's elements from the Figma API (type, name, position, size, text, font, colour), rebuilt as invisible HTML elements over the image. This gives the Figma baseline a DOM.

A link with only `?img=` still works and shows the design image without the DOM.

## Use it in Autonomous

1. Set the viewport width to the Figma frame width (the height can be anything).
2. Run 1: open the baseline link and take a full-page visual checkpoint.
3. Run 2: change only the URL to the live website page and run again.
