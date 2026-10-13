// define `EXCALIDRAW_ASSET_PATH` as a SSOT
const OSS_FONTS_CDN = "https://excalidraw.nyc3.cdn.digitaloceanspaces.com/oss/";

/**
 * Custom vite plugin for auto-prefixing `EXCALIDRAW_ASSET_PATH` woff2 fonts in `excalidraw-app`.
 *
 * @param {{ preloadFonts?: string[] }} [options] font paths (relative to `base`) to preload
 * @returns {import("vite").PluginOption}
 */
module.exports.woff2BrowserPlugin = ({ preloadFonts = [] } = {}) => {
  let isDev;
  let base = "/";

  return {
    name: "woff2BrowserPlugin",
    enforce: "pre",
    config(_, { command }) {
      isDev = command === "serve";
    },
    configResolved(config) {
      base = config.base;
    },
    transform(code, id) {
      // using copy / replace as fonts defined in the `.css` don't have to be manually copied over (vite/rollup does this automatically),
      // but at the same time can't be easily prefixed with the `EXCALIDRAW_ASSET_PATH` only for the `excalidraw-app`
      if (!isDev && id.endsWith("/excalidraw/fonts/fonts.css")) {
        return `/* WARN: The following content is generated during excalidraw-app build */

      @font-face {
        font-family: "Assistant";
        src: url(${OSS_FONTS_CDN}fonts/Assistant/Assistant-Regular.woff2)
            format("woff2"),
          url(./Assistant-Regular.woff2) format("woff2");
        font-weight: 400;
        style: normal;
        display: swap;
      }

      @font-face {
        font-family: "Assistant";
        src: url(${OSS_FONTS_CDN}fonts/Assistant/Assistant-Medium.woff2)
            format("woff2"),
          url(./Assistant-Medium.woff2) format("woff2");
        font-weight: 500;
        style: normal;
        display: swap;
      }

      @font-face {
        font-family: "Assistant";
        src: url(${OSS_FONTS_CDN}fonts/Assistant/Assistant-SemiBold.woff2)
            format("woff2"),
          url(./Assistant-SemiBold.woff2) format("woff2");
        font-weight: 600;
        style: normal;
        display: swap;
      }

      @font-face {
        font-family: "Assistant";
        src: url(${OSS_FONTS_CDN}fonts/Assistant/Assistant-Bold.woff2)
            format("woff2"),
          url(./Assistant-Bold.woff2) format("woff2");
        font-weight: 700;
        style: normal;
        display: swap;
      }`;
      }

      if (!isDev && id.endsWith("excalidraw-app/index.html")) {
        // fork: fonts are self-hosted under the vite `base` (e.g. /excalidraw/),
        // since our Excalifont (DFVN, with Vietnamese glyphs) isn't on the OSS CDN.
        // Bundled font uris already include `base`, so the asset path is the origin root.
        const preloads = [
          ...preloadFonts,
          "fonts/Assistant/Assistant-SemiBold.woff2",
        ];

        return code.replace(
          "<!-- PLACEHOLDER:EXCALIDRAW_APP_FONTS -->",
          `<script>
        window.EXCALIDRAW_ASSET_PATH = "/";
      </script>

      <!-- Preload Excalifont to avoid swap on init -->
      ${preloads
        .map(
          (href) => `<link
        rel="preload"
        href="${base}${href}"
        as="font"
        type="font/woff2"
        crossorigin="anonymous"
      />`,
        )
        .join("\n      ")}
    `,
        );
      }
    },
  };
};
