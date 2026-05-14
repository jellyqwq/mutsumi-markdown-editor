(function () {
  const vscode = acquireVsCodeApi();

  let editor;
  let settings = {};
  let suppressChange = false;
  let updateTimer;
  let themeObserver;
  let themeStyleElement;
  let outlineObserver;
  let lastOutlineState;
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
          outlineEnabled: Boolean(message.outlineEnabled),
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
      outline: {
        enable: settings.outlineEnabled,
        position: "left",
      },
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
        ensureToolbarIconFallback();
        applyOutlineState(settings.outlineEnabled);
        watchOutlineState();
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
    injectThemePatch();
    ensureToolbarIconFallback();

    if (!editor || typeof editor.setTheme !== "function") {
      return;
    }

    editor.setTheme(getVditorTheme());
    window.setTimeout(() => {
      injectThemePatch();
      ensureToolbarIconFallback();
    }, 0);
  }

  function getVditorTheme() {
    if (document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast")) {
      return "dark";
    }

    return "classic";
  }

  function injectThemePatch() {
    if (!themeStyleElement) {
      themeStyleElement = document.createElement("style");
      themeStyleElement.id = "mutsumi-theme-patch";
      document.head.appendChild(themeStyleElement);
    }

    const isDark = document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast");
    const icon = isDark ? "#d4d4d4" : "#4b5563";
    const iconHover = isDark ? "#ffffff" : "#0969da";
    const editorBg = readCssVariable("--vscode-editor-background", isDark ? "#1e1e1e" : "#ffffff");
    const editorFg = readCssVariable("--vscode-editor-foreground", isDark ? "#d4d4d4" : "#24292f");
    const toolbarBg = readCssVariable("--vscode-editorGroupHeader-tabsBackground", editorBg);
    const border = readCssVariable("--vscode-panel-border", isDark ? "#3c3c3c" : "#d0d7de");

    themeStyleElement.textContent = `
      body .vditor {
        --border-color: ${border} !important;
        --toolbar-background-color: ${toolbarBg} !important;
        --toolbar-icon-color: ${icon} !important;
        --toolbar-icon-hover-color: ${iconHover} !important;
        --textarea-background-color: ${editorBg} !important;
        --textarea-text-color: ${editorFg} !important;
        background: ${editorBg} !important;
        color: ${editorFg} !important;
      }
      body .vditor-toolbar {
        background: ${toolbarBg} !important;
        border-bottom-color: ${border} !important;
      }
      body .vditor-toolbar__item .vditor-tooltipped,
      body .vditor-icon {
        color: ${icon} !important;
        opacity: 1 !important;
      }
      body .vditor-toolbar__item .vditor-tooltipped:hover,
      body .vditor-toolbar__item .vditor-tooltipped:focus,
      body .vditor-toolbar__item .vditor-tooltipped:active,
      body .vditor-icon:hover,
      body .vditor-icon--current,
      body .vditor-menu--current {
        color: ${iconHover} !important;
      }
      body .vditor-toolbar__item svg,
      body .vditor-toolbar__item svg *,
      body .vditor-toolbar__item svg use,
      body .vditor-toolbar__item svg path,
      body .vditor-icon svg,
      body .vditor-icon svg *,
      body .vditor-icon svg use,
      body .vditor-icon svg path {
        color: inherit !important;
        fill: currentColor !important;
        stroke: currentColor !important;
        opacity: 1 !important;
        visibility: visible !important;
      }
      body .vditor-content,
      body .vditor-wysiwyg,
      body .vditor-ir,
      body .vditor-sv,
      body .vditor-preview,
      body .vditor-reset,
      body .vditor-textarea {
        background: ${editorBg} !important;
        color: ${editorFg} !important;
      }
    `;
  }

  function readCssVariable(name, fallback) {
    return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
  }

  function ensureToolbarIconFallback() {
    const apply = () => {
      const hasVditorSymbols = Boolean(document.getElementById("vditor-icon-undo"));
      document.body.classList.toggle("mutsumi-icon-fallback", !hasVditorSymbols);
    };

    apply();
    window.setTimeout(apply, 100);
    window.setTimeout(apply, 500);
  }

  function applyOutlineState(enabled) {
    if (!editor || !editor.vditor || !editor.vditor.outline) {
      return;
    }

    editor.vditor.options.outline.enable = Boolean(enabled);
    editor.vditor.outline.toggle(editor.vditor, Boolean(enabled), false);
    rememberOutlineState(Boolean(enabled), false);
  }

  function watchOutlineState() {
    if (outlineObserver || !editor || !editor.vditor) {
      return;
    }

    const notify = () => {
      window.setTimeout(() => rememberOutlineState(readOutlineState(), true), 0);
    };
    const outlineButton = editor.vditor.toolbar.elements.outline?.firstElementChild;
    outlineButton?.addEventListener("click", notify);

    outlineObserver = new MutationObserver(notify);
    if (editor.vditor.outline?.element) {
      outlineObserver.observe(editor.vditor.outline.element, {
        attributes: true,
        attributeFilter: ["style", "class"],
      });
    }
    if (outlineButton) {
      outlineObserver.observe(outlineButton, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }

    rememberOutlineState(readOutlineState(), false);
  }

  function readOutlineState() {
    if (!editor || !editor.vditor || !editor.vditor.outline) {
      return false;
    }

    return editor.vditor.outline.element.style.display !== "none" && Boolean(editor.vditor.options.outline.enable);
  }

  function rememberOutlineState(enabled, notifyExtension) {
    if (lastOutlineState === enabled) {
      return;
    }

    lastOutlineState = enabled;
    if (notifyExtension) {
      vscode.postMessage({
        type: "outlineState",
        enabled,
      });
    }
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
