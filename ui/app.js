const elements = Object.fromEntries(
  ["runtime-status", "allowed-origins", "browser-path", "headless", "notice", "save", "launch", "close", "refresh"].map(
    (id) => [id, document.getElementById(id)],
  ),
);

function bridge() {
  const api = window.baijimuLocalApp;
  if (!api || api.version !== 1 || typeof api.invoke !== "function") {
    throw new Error("当前百积木版本不支持本地应用界面，请升级到 0.6.0 或更高版本。");
  }
  return api;
}

function show(message, error = false) {
  elements.notice.textContent = message;
  elements.notice.hidden = !message;
  elements.notice.className = `notice${error ? " error" : ""}`;
}

function setBusy(busy) {
  for (const id of ["save", "launch", "close", "refresh"]) elements[id].disabled = busy;
}

function renderState(state) {
  const authorization = state?.authorization || {};
  const runtime = state?.runtime || {};
  elements["allowed-origins"].value = (authorization.allowedOrigins || []).join("\n");
  elements["browser-path"].value = authorization.browserExecutablePath || "";
  elements.headless.checked = authorization.headless === true;
  elements["runtime-status"].textContent = runtime.running ? `运行中 · ${runtime.pageCount || 0} 个页面` : "已停止";
  elements["runtime-status"].className = `badge${runtime.running ? " running" : ""}`;
}

async function invoke(operation, payload) {
  return bridge().invoke(operation, payload);
}

async function refresh() {
  setBusy(true);
  try {
    renderState(await invoke("getState"));
    show("");
  } catch (error) {
    show(error instanceof Error ? error.message : String(error), true);
  } finally {
    setBusy(false);
  }
}

elements.save.addEventListener("click", async () => {
  setBusy(true);
  try {
    const allowedOrigins = elements["allowed-origins"].value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const state = await invoke("saveAuthorization", {
      allowedOrigins,
      browserExecutablePath: elements["browser-path"].value.trim() || null,
      headless: elements.headless.checked,
    });
    renderState(state);
    show("授权已保存。浏览器已关闭，请重新启动后使用新授权。");
  } catch (error) {
    show(error instanceof Error ? error.message : String(error), true);
  } finally {
    setBusy(false);
  }
});

elements.launch.addEventListener("click", async () => {
  setBusy(true);
  try {
    await invoke("launchBrowser", {});
    await refresh();
    show("浏览器已启动。登录态会保存在应用私有目录中。");
  } catch (error) {
    show(error instanceof Error ? error.message : String(error), true);
  } finally {
    setBusy(false);
  }
});

elements.close.addEventListener("click", async () => {
  setBusy(true);
  try {
    await invoke("closeBrowser", {});
    await refresh();
    show("浏览器已关闭，登录态仍保留在本机。");
  } catch (error) {
    show(error instanceof Error ? error.message : String(error), true);
  } finally {
    setBusy(false);
  }
});

elements.refresh.addEventListener("click", () => void refresh());
void refresh();
