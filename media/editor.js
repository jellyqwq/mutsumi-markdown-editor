(function () {
  const vscode = acquireVsCodeApi();

  let editor;
  let settings = {};
  let suppressChange = false;
  let updateTimer;
  let themeObserver;
  const pendingImages = new Map();

  window.addEventListener("message", (event) => {
    const message = event.data;

    switch (message.type) {
      case "init":
        settings = {
          vditorCdnUri: trimTrailingSlash(message.vditorCdnUri || ""),
          publicBaseUri: trimTrailingSlash(message.publicBaseUri || ""),
          documentDirUri: trimTrailingSlash(message.documentDirUri || ""),
          imageRoot: message.imageRoot || "/images",
        };
        createEditor(message.text || "");
        break;

      case "setContent":
        if (editor && getMarkdownValue() !== message.text) {
          suppressChange = true;
          editor.setValue(message.text || "");
          queueImageResolution();
          suppressChange = false;
        }
        break;

      case "imageSaved":
        finishImageSave(message.requestId, message.link, message.alt);
        break;

      case "imageSaveFailed":
        failImageSave(message.requestId, message.message);
        break;
    }
  });

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", postReady);
  } else {
    postReady();
  }

  function postReady() {
    vscode.postMessage({ type: "ready" });
  }

  function createEditor(initialValue) {
    if (editor) {
      return;
    }

    editor = new Vditor("editor", {
      mode: "wysiwyg",
      theme: getVditorTheme(),
      value: initialValue,
      height: "100%",
      lang: "zh_CN",
      cache: {
        enable: false,
      },
      cdn: settings.vditorCdnUri,
      input() {
        if (suppressChange) {
          return;
        }

        queueDocumentUpdate();
        queueImageResolution();
      },
      after() {
        applyEditorTheme();
        watchThemeChanges();
        queueImageResolution();
      },
      upload: {
        accept: "image/*",
        handler(files) {
          saveImages(files);
          return null;
        },
      },
    });
  }

  function watchThemeChanges() {
    if (themeObserver) {
      return;
    }

    themeObserver = new MutationObserver(applyEditorTheme);
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  function applyEditorTheme() {
    if (!editor || typeof editor.setTheme !== "function") {
      return;
    }

    editor.setTheme(getVditorTheme());
  }

  function getVditorTheme() {
    if (document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast")) {
      return "dark";
    }

    return "classic";
  }

  function saveImages(files) {
    Array.from(files || [])
      .filter((file) => file && file.type && file.type.startsWith("image/"))
      .forEach((file) => {
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        pendingImages.set(requestId, file);

        const reader = new FileReader();
        reader.onload = () => {
          vscode.postMessage({
            type: "saveImage",
            requestId,
            name: file.name,
            mime: file.type,
            dataUrl: String(reader.result || ""),
          });
        };
        reader.onerror = () => {
          pendingImages.delete(requestId);
        };
        reader.readAsDataURL(file);
      });
  }

  function finishImageSave(requestId, link, alt) {
    const file = pendingImages.get(requestId);
    pendingImages.delete(requestId);

    const text = `![${escapeMarkdownText(alt || (file && file.name) || "image")}](${link})\n`;
    editor.insertMD(text);
    queueDocumentUpdate();
    queueImageResolution();
  }

  function failImageSave(requestId, message) {
    pendingImages.delete(requestId);
    console.error(message || "Failed to save image.");
  }

  function queueDocumentUpdate() {
    window.clearTimeout(updateTimer);
    updateTimer = window.setTimeout(() => {
      vscode.postMessage({
        type: "update",
        text: getMarkdownValue(),
      });
    }, 250);
  }

  function getMarkdownValue() {
    if (!editor) {
      return "";
    }

    return normalizeMarkdownLinks(withOriginalImageSources(() => editor.getValue()));
  }

  function withOriginalImageSources(callback) {
    const changed = [];

    document.querySelectorAll("#editor img[data-mutsumi-original-src]").forEach((img) => {
      changed.push([img, img.getAttribute("src") || ""]);
      img.setAttribute("src", img.getAttribute("data-mutsumi-original-src") || "");
    });

    try {
      return callback();
    } finally {
      changed.forEach(([img, src]) => {
        img.setAttribute("src", src);
      });
    }
  }

  function queueImageResolution() {
    window.requestAnimationFrame(resolveImages);
  }

  function resolveImages() {
    document.querySelectorAll("#editor img").forEach((img) => {
      const originalSrc = img.getAttribute("data-mutsumi-original-src") || img.getAttribute("src") || "";
      const resolvedSrc = resolveImageSource(originalSrc);

      if (resolvedSrc && resolvedSrc !== originalSrc) {
        img.setAttribute("data-mutsumi-original-src", originalSrc);
        img.setAttribute("src", resolvedSrc);
      }
    });
  }

  function resolveImageSource(src) {
    if (!src || isExternalOrSpecialUri(src)) {
      return src;
    }

    const imageRoot = settings.imageRoot.replace(/\/+$/g, "");
    if (settings.publicBaseUri && src.startsWith(`${imageRoot}/`)) {
      return `${settings.publicBaseUri}${src}`;
    }

    if (settings.publicBaseUri && src.startsWith(`${imageRoot.slice(1)}/`)) {
      return `${settings.publicBaseUri}/${src}`;
    }

    if (settings.documentDirUri && !src.startsWith("/")) {
      return `${settings.documentDirUri}/${src.replace(/^\.?\//, "")}`;
    }

    return src;
  }

  function normalizeMarkdownLinks(value) {
    let next = value;

    if (settings.publicBaseUri) {
      const escapedBase = escapeRegExp(settings.publicBaseUri);
      next = next.replace(new RegExp(`${escapedBase}/?`, "g"), "/");
    }

    if (settings.documentDirUri) {
      const escapedDocumentDir = escapeRegExp(settings.documentDirUri);
      next = next.replace(new RegExp(`${escapedDocumentDir}/?`, "g"), "");
    }

    return next;
  }

  function isExternalOrSpecialUri(src) {
    return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src);
  }

  function trimTrailingSlash(value) {
    return value.replace(/\/+$/g, "");
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function escapeMarkdownText(value) {
    return String(value).replace(/[[\]\\]/g, "\\$&");
  }
})();
