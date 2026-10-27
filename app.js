function isAllowedSchoolEmail(value) {
  const email=String(value || "").trim().toLowerCase();
  const parts=email.split("@");
  return parts.length===2 && parts[1]==="tallah.habitatschool.org" &&
    /^[a-z0-9._%+-]+$/.test(parts[0]) && !parts[0].startsWith(".") &&
    !parts[0].endsWith(".") && !parts[0].includes("..");
}
const API_URL =
  "https://script.google.com/macros/s/AKfycbxL0l9rzGboqSVXYL7lUire12YtGcFBy2hSADTya9_xsw1h1Uk1vf8Y5SzJrZdcxaOw/exec";
const APP_STORAGE_SCOPE = Array.from(location.pathname || "examready").reduce((hash, char) => ((hash * 31 + char.charCodeAt(0)) >>> 0), 0).toString(36),
  TAB_SESSION_KEY = `examready_session_${APP_STORAGE_SCOPE}`,
  REMEMBERED_SESSION_KEY = `examready_remembered_session_${APP_STORAGE_SCOPE}`;
let currentUser = null,
  currentToken = "",
  soundOn = (()=>{try{return localStorage.getItem("examready_sound")!=="off"}catch{return true}})(),
  loadedExams = [],
  loadedReminders = [],
  loadedReminderPlans = [],
  loadedStudyPlans = [],
  studyPlansLoaded = false,
  studyPlansLoading = false,
  studyPlanMutationBusy = false,
  sessionVersion = 0,
  dashboardController = null,
  chatHistory = [],
  restoreGeneration = 0,
  manualLoginStarted = false;
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
function makeRequestId() {
  return (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^a-zA-Z0-9-]/g, "");
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function recoverOperation(requestId, token) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await wait(250 + attempt * 250);
    try {
      const response = await fetch(`${API_URL}?action=operationStatus&requestId=${encodeURIComponent(requestId)}&sessionToken=${encodeURIComponent(token || "")}&t=${Date.now()}`, { cache: "no-store", redirect: "follow" });
      if (!response.ok) continue;
      const status = await response.json();
      if (status.success && status.found) return status.result;
    } catch {}
  }
  return null;
}
async function apiPost(action, data = {}) {
  const requestId = makeRequestId(), requestToken = data.sessionToken || currentToken || "";
  let originalError = null;
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, requestId, sessionToken: requestToken || undefined, ...data }),
    });
    if (!response.ok) throw Error(`Data request failed (${response.status})`);
    const result = await response.json();
    if (!result.success) {
      const failure=Error(result.error || "Request failed"); failure.serverRejected=true; throw failure;
    }
    return result;
  } catch (error) {
    if(error.serverRejected) throw error;
    originalError = error;
  }
  if (action === "adminDashboard") throw originalError;
  const recovered = await recoverOperation(requestId, requestToken);
  if (recovered) {
    if (!recovered.success) throw Error(recovered.error || "Request failed");
    return recovered;
  }
  throw originalError;
}
async function apiGet(action, options = {}) {
  const tokenPart = currentToken ? `&sessionToken=${encodeURIComponent(currentToken)}` : "";
  let lastError = Error("Could not load data.");
  for (let attempt = 0; attempt < 4; attempt++) {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const response = await fetch(`${API_URL}?action=${encodeURIComponent(action)}${tokenPart}&t=${Date.now()}&attempt=${attempt}`, { cache: "no-store", redirect: "follow", signal: options.signal });
      if (!response.ok) throw Error(`Data request failed (${response.status})`);
      const result = await response.json();
      if (!result.success) { const failure=Error(result.error || "Request failed");failure.serverRejected=true;throw failure; }
      return result;
    } catch (error) {
      if (error.name === "AbortError") throw error;
      lastError = error;
      if (error.serverRejected || isSessionError(error) || /not approved|disabled/i.test(error.message)) throw error;
      if (attempt < 3) await wait(300 + attempt * 450);
    }
  }
  throw lastError;
}
function beep() {
  if (!soundOn) return;
  try {
    const C = window.AudioContext || window.webkitAudioContext,
      c = new C(),
      o = c.createOscillator(),
      g = c.createGain();
    o.frequency.setValueAtTime(520, c.currentTime);
    o.frequency.exponentialRampToValueAtTime(760, c.currentTime + 0.045);
    g.gain.setValueAtTime(0.035, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.07);
    o.connect(g);
    g.connect(c.destination);
    o.start();
    o.stop(c.currentTime + 0.07);
  } catch {}
}
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2800);
}
function modal(id) {
  const d = document.getElementById(id);
  if (d && !d.open) d.showModal();
}
function closeDialogs() {
  $$("dialog[open]").forEach((d) => d.close());
}
function selectRole(role) {
  $("#signupForm [name=role]").value = role;
  $$("[data-pick-role]").forEach((b) =>
    b.classList.toggle("active", b.dataset.pickRole === role),
  );
  const field = $(".student-class-field"),
    input = field.querySelector("input");
  field.classList.toggle("hidden", role !== "student");
  input.disabled = role !== "student";
  input.required = role === "student";
  $("#signupReminderChoices").classList.toggle("hidden",role!=="student");
}
function busy(form, on, label) {
  form.dataset.sending = on ? "true" : "false";
  const b = form.querySelector('button[type="submit"]');
  if (!b) return;
  if (!b.dataset.text) b.dataset.text = b.textContent;
  b.disabled = on;
  b.textContent = on ? label : b.dataset.text;
}
function friendly(error) {
  return error.message.includes("Failed to fetch")
    ? "Could not reach the data service. Check your internet and Apps Script deployment."
    : error.message;
}
function normClass(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}
function setSession(account, token) {
  busy($("#studentSettingsForm"),false);
  if (!account || !token) throw Error("Secure login information is missing. Please log in again.");
  sessionVersion += 1;
  if (dashboardController) dashboardController.abort();
  dashboardController = null;
  loadedExams = [];
  loadedReminders = [];
  loadedReminderPlans = [];
  loadedStudyPlans = [];
  studyPlansLoaded = false;
  studyPlansLoading = false;
  studyPlanMutationBusy = false;
  busy($("#feedbackForm"),false);
  currentUser = { ...account };
  currentToken = token;
  const savedSession = JSON.stringify({ account: currentUser, sessionToken: currentToken });
  sessionStorage.setItem(TAB_SESSION_KEY, savedSession);
  localStorage.setItem(REMEMBERED_SESSION_KEY, savedSession);
  localStorage.removeItem("examready_google_session");
  loadChatHistory();
}
function clearSession() {
  $("#feedbackForm")?.reset();
  if($("#feedbackSuccess")){$("#feedbackSuccess").textContent="";$("#feedbackSuccess").classList.add("hidden");}
  if($("#feedbackError"))$("#feedbackError").textContent="";
  if($("#feedbackLength"))$("#feedbackLength").textContent="0 / 1500";
  adminLoadId += 1;
  adminLoading = false;
  adminBusy = false;
  adminData = null;
  ["#adminUsers","#adminExams","#adminStats","#adminFeedbackList"].forEach(selector=>{if($(selector))$(selector).innerHTML="";});
  const token = currentToken;
  sessionVersion += 1;
  if (dashboardController) dashboardController.abort();
  dashboardController = null;
  currentUser = null;
  currentToken = "";
  loadedExams = [];
  loadedReminders = [];
  loadedReminderPlans = [];
  loadedStudyPlans = [];
  studyPlansLoaded = false;
  studyPlansLoading = false;
  studyPlanMutationBusy = false;
  chatHistory = [];
  sessionStorage.removeItem(TAB_SESSION_KEY);
  localStorage.removeItem("examready_google_session");
  try {
    const remembered = JSON.parse(localStorage.getItem(REMEMBERED_SESSION_KEY) || "null");
    if (token && remembered?.sessionToken === token) localStorage.removeItem(REMEMBERED_SESSION_KEY);
  } catch { localStorage.removeItem(REMEMBERED_SESSION_KEY); }
}
function isSessionError(error) {
  return /session|log in again|authentication/i.test(String(error && error.message || error || ""));
}
function logout() {
  const token = currentToken;
  showPublic();
  toast("Logged out");
  if (token) apiPost("logout", { sessionToken: token }).catch(() => {});
}
function chatStorageKey() { return currentUser ? `examready_chat_${currentUser.email.toLowerCase()}` : ""; }
function loadChatHistory() {
  const key = chatStorageKey();
  chatHistory = [];
  if (key) try { chatHistory = JSON.parse(localStorage.getItem(key) || "[]").filter(x => x && ["user","assistant"].includes(x.role) && typeof x.text === "string").slice(-16); } catch {}
  renderChat();
}
function saveChatHistory() {
  const key = chatStorageKey();
  if (key) localStorage.setItem(key, JSON.stringify(chatHistory.slice(-16)));
}
function inlineMarkdown(text) {
  let value = esc(text), tokens = [];
  value = value.replace(/`([^`\n]+)`/g, (_, code) => { const token = `@@CODE${tokens.length}@@`; tokens.push(`<code>${code}</code>`); return token; });
  value = value.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  value = value.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  value = value.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, "$1<em>$2</em>");
  value = value.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, "$1<em>$2</em>");
  tokens.forEach((html, index) => { value = value.replace(`@@CODE${index}@@`, html); });
  return value;
}
function markdownToHtml(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n"), out = [];
  let list = "", inCode = false, codeLines = [];
  const closeList = () => { if (list) { out.push(`</${list}>`); list = ""; } };
  for (const raw of lines) {
    if (/^```/.test(raw.trim())) {
      closeList();
      if (inCode) { out.push(`<pre><code>${esc(codeLines.join("\n"))}</code></pre>`); codeLines = []; inCode = false; }
      else inCode = true;
      continue;
    }
    if (inCode) { codeLines.push(raw); continue; }
    const unordered = raw.match(/^\s*[-*+]\s+(.+)/), ordered = raw.match(/^\s*\d+[.)]\s+(.+)/), heading = raw.match(/^\s*(#{1,3})\s+(.+)/);
    if (unordered || ordered) {
      const kind = unordered ? "ul" : "ol", content = unordered ? unordered[1] : ordered[1];
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inlineMarkdown(content)}</li>`); continue;
    }
    closeList();
    if (!raw.trim()) { out.push(""); continue; }
    if (heading) { const level = Math.min(4, heading[1].length + 2); out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`); }
    else if (/^\s*>\s?/.test(raw)) out.push(`<blockquote>${inlineMarkdown(raw.replace(/^\s*>\s?/, ""))}</blockquote>`);
    else out.push(`<p>${inlineMarkdown(raw)}</p>`);
  }
  closeList();
  if (inCode) out.push(`<pre><code>${esc(codeLines.join("\n"))}</code></pre>`);
  return out.join("");
}
function renderChat() {
  const box = $("#chatMessages");
  if (!box) return;
  if (!chatHistory.length) box.innerHTML = '<div class="chat-welcome"><span>✦</span><div><strong>Ready when you are</strong><p>Ask for a simple explanation, a revision plan, or a quick quiz.</p></div></div>';
  else box.innerHTML = chatHistory.map(item => `<div class="chat-row ${item.role}"><div class="chat-bubble"><b>${item.role === "user" ? "You" : "reminder.ai Study Assistant"}</b><div class="message-content">${markdownToHtml(item.text)}</div></div></div>`).join("");
  box.scrollTop = box.scrollHeight;
}
async function sendChat(e) {
  e.preventDefault();
  const form = e.currentTarget, input = $("#chatInput"), error = $("#chatError"), message = input.value.trim(), user = currentUser, version = sessionVersion;
  if (!user || !message || form.dataset.sending==="true") return;
  error.textContent = "";
  const prior = chatHistory.slice(-8), examId = input.dataset.examId || "";
  chatHistory.push({ role: "user", text: message });
  saveChatHistory(); renderChat(); input.value = "";
  busy(form, true, "Thinking…");
  $("#chatMessages").insertAdjacentHTML("beforeend",'<div class="thinking" role="status" id="chatThinking"><i></i><i></i><i></i><span>Preparing your answer…</span></div>');
  $("#chatMessages").scrollTop=$("#chatMessages").scrollHeight;
  try {
    const result = await apiPost("chat", { userEmail: user.email, message, history: prior, examId });
    if (version !== sessionVersion || currentUser?.email !== user.email) return;
    chatHistory.push({ role: "assistant", text: result.answer });
    delete input.dataset.examId;
    saveChatHistory(); renderChat();
  } catch (x) {
    if (version !== sessionVersion) return;
    error.textContent = friendly(x);
    chatHistory = chatHistory.filter((_, index) => index !== chatHistory.length - 1);
    saveChatHistory(); renderChat();
    input.value = message;
  } finally { if (version === sessionVersion) {$("#chatThinking")?.remove();busy(form, false);} }
}
function clearChat() {
  if (!currentUser || !confirm("Clear this account's chat history?")) return;
  chatHistory = []; saveChatHistory(); renderChat(); toast("Chat cleared");
}
async function signup(e) {
  e.preventDefault();
  const signupVersion=sessionVersion, signupGeneration=restoreGeneration;
  if(e.currentTarget.dataset.sending==="true")return;
  const form = e.currentTarget,
    data = Object.fromEntries(new FormData(form)),
    err = $("#signupError");
  err.textContent = "";
  data.email = data.email.trim().toLowerCase();
  data.schoolId = data.schoolId.trim();
  data.whatsapp = data.whatsapp.trim();
  if (!isAllowedSchoolEmail(data.email)) {
    err.textContent = "Use your school email ending in @tallah.habitatschool.org.";
    return;
  }
  if (!/^\+[1-9]\d{7,14}$/.test(data.whatsapp)) {
    err.textContent = "Use WhatsApp format +countrycode and number.";
    return;
  }
  if (data.role === "student" && !normClass(data.classGrade)) {
    err.textContent = "Enter your class or grade.";
    return;
  }
  busy(form, true, "Saving your data…");
  try {
    const signupResult = await apiPost("signup", {
      role: data.role,
      name: data.name.trim(),
      email: data.email,
      schoolId: data.schoolId,
      whatsapp: data.whatsapp,
      password: data.password,
      classGrade: data.role === "student" ? data.classGrade.trim() : "",
      ...Object.fromEntries(["reminder7","reminder3","reminder1","reminderDay"].map(k=>[k,form.elements[k].checked])),
      whatsappOptIn: data.role === "student" && form.elements.whatsappOptIn.checked,
    });
    if(signupVersion!==sessionVersion || signupGeneration!==restoreGeneration)return;
    if (!signupResult.verificationRequired || !signupResult.verificationId) throw Error("Verification setup is missing. Update the Apps Script deployment before testing signup.");
    rememberEmailVerification(signupResult);
    form.elements.password.value="";
    closeDialogs();openEmailVerification();
  } catch (x) {
    err.textContent = friendly(x);
  } finally {
    busy(form, false);
  }
}
function beginManualLogin() {
  manualLoginStarted = true;
  restoreGeneration += 1;
}
async function login(e) {
  e.preventDefault();
  if(e.currentTarget.dataset.sending==="true")return;
  beginManualLogin();
  const form = e.currentTarget,
    data = Object.fromEntries(new FormData(form)),
    err = $("#loginError");
  err.textContent = "";
  busy(form, true, "Checking your account…");
  try {
    const result = await apiPost("login", {
      email: data.email.trim().toLowerCase(),
      password: data.password,
    });
    setSession(result.account, result.sessionToken);
    closeDialogs();
    toast(`Welcome back, ${currentUser.name.split(" ")[0]}`);
    showDashboard();
  } catch (x) {
    err.textContent = friendly(x);
  } finally {
    busy(form, false);
  }
}
function readFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    if (file.size > 8 * 1024 * 1024)
      return reject(Error("File must be 8 MB or smaller."));
    const allowed = [
      "application/pdf",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "image/png",
      "image/jpeg",
    ];
    if (!allowed.includes(file.type))
      return reject(Error("Use PDF, PPT, PPTX, DOC, DOCX, PNG, or JPG."));
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        name: file.name,
        type: file.type,
        data: String(reader.result).split(",")[1],
      });
    reader.onerror = () =>
      reject(Error("The selected file could not be read."));
    reader.readAsDataURL(file);
  });
}
async function saveExam(e) {
  e.preventDefault();
  if (currentUser?.role !== "teacher" || e.currentTarget.dataset.sending==="true") return;
  const user=currentUser, version=sessionVersion;
  const form = e.currentTarget,
    data = Object.fromEntries(new FormData(form)),
    err = $("#examError"),
    file = form.querySelector('[name="attachment"]').files[0],
    editing = Boolean(data.examId);
  err.textContent = "";
  if (new Date(data.examAt) <= new Date()) {
    err.textContent = "Choose a future date and time.";
    return;
  }
  busy(
    form,
    true,
    file ? "Uploading file…" : editing ? "Saving changes…" : "Saving exam…",
  );
  try {
    const reminder7=true,reminder3=true,reminder1=true,reminderDay=true,reminderPaused=false;
    if (!reminderPaused && !reminder7 && !reminder3 && !reminder1 && !reminderDay) {
      err.textContent = "Select at least one reminder or pause reminders for this exam.";
      busy(form, false);
      return;
    }
    const payload = await readFile(file);
    const result = await apiPost(editing ? "updateExam" : "createExam", {
      teacherEmail: currentUser.email,
      examId: data.examId || undefined,
      title: data.title.trim(),
      subject: data.subject.trim(),
      classGrade: data.classGrade.trim(),
      examAt: new Date(data.examAt).toISOString(),
      notes: data.notes.trim(),
      aiGuidance: String(data.aiGuidance || "").trim(),
      reminder7, reminder3, reminder1, reminderDay, reminderPaused,
      reminderMessage: String(data.reminderMessage || "").trim(),
      file: payload,
    });
    if(version!==sessionVersion || currentUser?.email!==user.email)return;
    const oldExam = editing ? loadedExams.find(x => String(x.id) === String(data.examId)) : null;
    const files = result.file ? [{ name: result.file.name, url: result.file.url, type: result.file.type }] : (oldExam?.files || []);
    const savedExam = { id: editing ? data.examId : result.examId, teacherEmail: currentUser.email, title: data.title.trim(), subject: data.subject.trim(), classGrade: data.classGrade.trim(), examAt: new Date(data.examAt).toISOString(), notes: data.notes.trim(), aiGuidance: String(data.aiGuidance || "").trim(), reminder7, reminder3, reminder1, reminderDay, reminderPaused, reminderMessage: String(data.reminderMessage || "").trim(), files };
    loadedExams = (editing ? loadedExams.map(x => String(x.id) === String(data.examId) ? savedExam : x) : [...loadedExams, savedExam]).sort((a,b) => new Date(a.examAt) - new Date(b.examAt));
    renderExamLists();
    const enabledStages = [[reminder7,"7-days"],[reminder3,"3-days"],[reminder1,"1-day"],[reminderDay,"today"]].filter(x=>x[0]).map(x=>x[1]);
    const priorPlan = loadedReminderPlans.find(x => String(x.examId) === String(savedExam.id));
    const plan = { examId: savedExam.id, title: savedExam.title, subject: savedExam.subject, classGrade: savedExam.classGrade, examAt: savedExam.examAt, enabledStages, paused: reminderPaused, customMessage: savedExam.reminderMessage, studentCount: priorPlan?.studentCount || 0, readyCount: 0, sentCount: priorPlan?.sentCount || 0 };
    loadedReminderPlans = editing ? loadedReminderPlans.map(x => String(x.examId) === String(savedExam.id) ? plan : x) : [...loadedReminderPlans, plan];
    if(Array.isArray(result.reminderPlans)) loadedReminderPlans=result.reminderPlans;
    renderReminders();
    saveDashboardCache(user,{exams:loadedExams,reminders:loadedReminders,reminderPlans:loadedReminderPlans});
    setDataStatus(result.reminderPreparation?.deferred ? "Exam saved; due reminders will be retried by the daily check." : "Exam saved. Data is up to date.", result.reminderPreparation?.deferred ? "saved" : "ready");
    resetExamForm();
    closeDialogs();
    toast(
      editing
        ? "Exam updated successfully"
        : file
          ? "Exam and file published"
          : "Exam published",
    );

  } catch (x) {
    if(version===sessionVersion)err.textContent = friendly(x);
  } finally {
    busy(form, false);
  }
}
function resetExamForm() {
  const f = $("#examForm");
  f.reset();
  f.elements.examId.value = "";
  ["reminder7","reminder3","reminder1","reminderDay"].forEach(name => f.elements[name].checked = true);
  f.elements.reminderPaused.checked = false;
  f.elements.reminderMessage.value = "";
  $("#examModalTitle").textContent = "Create an exam";
  $("#examSubmitBtn").textContent = "Publish exam";
  $("#examSubmitBtn").dataset.text = "Publish exam";
  $("#fileName").textContent = "No file selected";
  $("#examError").textContent = "";
}
function openCreateExam() {
  resetExamForm();
  modal("examModal");
}
function reminderSetting(value) {
  if (value === "" || value === null || value === undefined) return true;
  return value === true || String(value).toLowerCase() === "true" || String(value) === "1";
}
function openEditExam(id) {
  const x = loadedExams.find((e) => String(e.id) === String(id));
  if (!x) return toast("Exam not found");
  const f = $("#examForm"),
    d = new Date(x.examAt),
    local = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  f.elements.examId.value = x.id;
  f.elements.title.value = x.title || "";
  f.elements.subject.value = x.subject || "";
  f.elements.classGrade.value = x.classGrade || "";
  f.elements.examAt.value = local;
  f.elements.notes.value = x.notes || "";
  f.elements.aiGuidance.value = x.aiGuidance || "";
  f.elements.reminder7.checked = reminderSetting(x.reminder7);
  f.elements.reminder3.checked = reminderSetting(x.reminder3);
  f.elements.reminder1.checked = reminderSetting(x.reminder1);
  f.elements.reminderDay.checked = reminderSetting(x.reminderDay);
  f.elements.reminderPaused.checked = x.reminderPaused === true || String(x.reminderPaused).toLowerCase() === "true";
  f.elements.reminderMessage.value = x.reminderMessage || "";
  f.elements.attachment.value = "";
  $("#examModalTitle").textContent = "Edit exam";
  $("#examSubmitBtn").textContent = "Save changes";
  $("#examSubmitBtn").dataset.text = "Save changes";
  $("#fileName").textContent = (x.files || []).length
    ? "Existing file stays unless you choose a new one"
    : "No file selected";
  $("#examError").textContent = "";
  modal("examModal");
}
const deletingExams = new Set();
async function removeExam(id) {
  const x=loadedExams.find(e=>String(e.id)===String(id));
  if(!x || deletingExams.has(id))return;
  if(!confirm(`Delete “${x.title}”? Its uploaded files will also be deleted.`))return;
  const version=sessionVersion;deletingExams.add(id);
  $$(`[data-exam-id="${CSS.escape(String(id))}"]`).forEach(b=>b.disabled=true);
  setDataStatus("Deleting exam…","loading");
  try {
    await apiPost("deleteExam",{examId:id});
    if(version!==sessionVersion)return;
    loadedExams=loadedExams.filter(e=>String(e.id)!==String(id));
    loadedReminderPlans=loadedReminderPlans.filter(e=>String(e.examId)!==String(id));
    renderExamLists();renderReminders();
    saveDashboardCache(currentUser,{exams:loadedExams,reminders:loadedReminders,reminderPlans:loadedReminderPlans});
    setDataStatus("Exam deleted. Data is up to date.");toast("Exam deleted");
  } catch(error) {
    if(version!==sessionVersion)return;
    setDataStatus("Deletion could not be confirmed. Refresh data before retrying.","error");toast(friendly(error));
  } finally {
    deletingExams.delete(id);
    if(version===sessionVersion)$$(`[data-exam-id="${CSS.escape(String(id))}"]`).forEach(b=>b.disabled=false);
  }
}

function esc(v) {
  return String(v ?? "").replace(
    /[&<>'"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        c
      ],
  );
}
function examCard(x) {
  const d = new Date(x.examAt),
    mon = d.toLocaleString("en", { month: "short" }).toUpperCase(),
    files = Array.isArray(x.files) ? x.files : [],
    studyPrompt = `Please help me revise for the ${x.subject || "subject"} exam \"${x.title || "upcoming exam"}\". Start with the teacher's important topics, formulas, and methods if provided, and explain them in simple steps. If no teacher guidance is available, explain using general knowledge and tell me what I should confirm with my teacher.`,
    actions =
      currentUser?.role === "teacher"
        ? `<div class="exam-actions"><button class="small-action edit-action click-sound" data-exam-action="edit" data-exam-id="${esc(x.id)}" type="button">Edit</button><button class="small-action delete-action click-sound" data-exam-action="delete" data-exam-id="${esc(x.id)}" type="button">Delete</button></div>`
        : currentUser?.role === "student"
          ? `<div class="exam-actions"><button class="small-action study-action click-sound" data-study-exam-id="${esc(x.id)}" data-chat-prompt="${esc(studyPrompt)}" type="button">Study with AI</button></div>`
          : "";
  return `<article class="exam-item"><div class="exam-date">${mon}<strong>${d.getDate()}</strong></div><div><h3>${esc(x.title)}</h3><p>${esc(x.subject)} · ${esc(x.classGrade)} · ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>${files.length ? `<div class="attachment-list">${files.map((f) => `<a class="attachment-link" href="${esc(f.url)}" target="_blank" rel="noopener">📎 ${esc(f.name)}</a>`).join("")}</div>` : ""}</div><div class="exam-side"><div class="exam-notes">${esc(x.notes || "Revision notes coming soon")}</div>${actions}</div></article>`;
}
function renderExamLists(exams = loadedExams) {
  const containers = [$("#examList"), $("#allExamList")];
  $("#statExams").textContent = exams.length;
  $("#statDays").textContent = exams[0]
    ? Math.max(
        0,
        Math.ceil((new Date(exams[0].examAt) - Date.now()) / 86400000),
      )
    : "—";
  const html = exams.length
    ? exams.map(examCard).join("")
    : '<div class="empty">No upcoming exams yet.</div>';
  containers.forEach((e) => (e.innerHTML = html));
}
function reminderStage(stage) {
  return ({ "7-days": "7 days", "3-days": "3 days", "1-day": "Tomorrow", today: "Today" })[stage] || "Reminder";
}
function reminderCard(item) {
  const date = new Date(item.examAt), stage = String(item.stage || ""), tone = stage === "today" ? "urgent" : stage === "1-day" ? "soon" : stage === "3-days" ? "prepare" : "early";
  return `<article class="reminder-item ${tone}"><div class="reminder-stage">${esc(reminderStage(stage))}</div><div class="reminder-copy"><h3>${esc(item.title || "Upcoming exam")}</h3><p>${esc(item.message || "Time to revise for your upcoming exam.")}</p><small>${esc(item.subject || "Exam")} · ${date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} at ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></div><span class="reminder-status">Ready</span></article>`;
}
function teacherReminderPlanCard(plan) {
  const labels = { "7-days": "7 days", "3-days": "3 days", "1-day": "1 day", today: "Exam day" }, stages = plan.enabledStages || [], paused = Boolean(plan.paused), status = paused ? "Paused" : plan.sentCount ? "Sent" : plan.readyCount ? "Ready" : "Scheduled";
  return `<article class="teacher-plan ${paused ? "paused" : ""}"><div class="plan-top"><div><span class="plan-status ${status.toLowerCase()}">${status}</span><h3>${esc(plan.title || "Exam")}</h3><p>${esc(plan.subject || "Exam")} · ${esc(plan.classGrade || "Class")} · ${new Date(plan.examAt).toLocaleDateString([], { month: "short", day: "numeric" })}</p></div><button class="button button-secondary click-sound" type="button" data-reminder-exam-id="${esc(plan.examId)}">Edit setup</button></div><div class="stage-row">${stages.length ? stages.map(stage => `<span>${esc(labels[stage] || stage)}</span>`).join("") : '<span class="off">No reminder stages</span>'}</div><div class="plan-metrics"><span><b>${Number(plan.studentCount || 0)}</b> matching students</span><span><b>${Number(plan.readyCount || 0)}</b> ready now</span><span><b>${Number(plan.sentCount || 0)}</b> sent</span></div>${plan.customMessage ? `<p class="plan-note"><b>Teacher note:</b> ${esc(plan.customMessage)}</p>` : ""}</article>`;
}
function renderReminders(reminders = loadedReminders) {
  const list = $("#reminderList"), count = $("#reminderNavCount"), teacher = currentUser?.role === "teacher";
  if (!list || !count) return;
  $("#studentReminderIntro").classList.toggle("hidden", teacher);
  $("#teacherReminderIntro").classList.toggle("hidden", !teacher);
  $("#reminderNote").textContent = teacher ? "Edit an exam to change its reminder stages, pause reminders, or add a note." : "Your selected reminder days can arrive in the portal and, if you opt in, by WhatsApp.";
  if (teacher) {
    count.textContent = loadedReminderPlans.length ? String(loadedReminderPlans.length) : "";
    count.classList.toggle("hidden", loadedReminderPlans.length === 0);
    list.innerHTML = loadedReminderPlans.length ? loadedReminderPlans.map(teacherReminderPlanCard).join("") : '<div class="empty"><strong>No reminder plans yet.</strong><p>Create an exam and choose its reminder stages.</p></div>';
    $("#statusStatLabel").textContent = "PUBLISHED EXAMS";
    $("#statusStatValue").textContent = loadedExams.length;
    $("#statusStatMeta").textContent = "Students choose their reminder days";
  } else {
    count.textContent = reminders.length ? String(reminders.length) : "";
    count.classList.toggle("hidden", reminders.length === 0);
    list.innerHTML = reminders.length ? reminders.map(reminderCard).join("") : '<div class="empty"><strong>No reminders due right now.</strong><p>Reminders appear on your selected days. Change them or turn all reminders off in Settings.</p></div>';
    $("#statusStatLabel").textContent = "REMINDERS";
    $("#statusStatValue").textContent = reminders.length;
    $("#statusStatMeta").textContent = reminders.length === 1 ? "reminder ready" : "reminders ready";
  }
}
function dashboardCacheKey(user) {
  return user ? `examready_dashboard_${APP_STORAGE_SCOPE}_${user.role}_${String(user.email || "").toLowerCase()}` : "";
}
function saveDashboardCache(user, result) {
  const key = dashboardCacheKey(user);
  if (key) try { sessionStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), result })); } catch {}
}
function loadDashboardCache(user) {
  const key = dashboardCacheKey(user);
  if (!key) return null;
  try {
    const cached = JSON.parse(sessionStorage.getItem(key) || "null");
    return cached && Date.now() - cached.savedAt < 30 * 60 * 1000 ? cached.result : null;
  } catch { return null; }
}
function applyDashboardData(user, result) {
  if(user.role==="student"&&result.preferences){Object.assign(currentUser,result.preferences);persistSettingsAccount();}
  loadedExams = (result.exams || []).filter(x => user.role === "teacher"
    ? String(x.teacherEmail || "").toLowerCase() === String(user.email).toLowerCase()
    : normClass(x.classGrade) === normClass(user.classGrade))
    .filter(x => new Date(x.examAt) > new Date())
    .sort((a, b) => new Date(a.examAt) - new Date(b.examAt));
  renderExamLists();
  loadedReminders = user.role === "student" ? (result.reminders || []).sort((a,b) => new Date(a.examAt) - new Date(b.examAt)) : [];
  loadedReminderPlans = user.role === "teacher" ? (result.reminderPlans || []).sort((a,b) => new Date(a.examAt) - new Date(b.examAt)) : [];
  renderReminders();
}
async function renderDashboard() {
  const user = currentUser;
  if (!user) return;
  const version = sessionVersion;
  if(dashboardController && currentUser?.role!=="admin")return;
  if (dashboardController) dashboardController.abort();
  const controller = new AbortController();
  dashboardController = controller;
  const containers = [$("#examList"), $("#allExamList")];
  $("#sideName").textContent = user.name;
  $("#sideRole").textContent = user.role[0].toUpperCase() + user.role.slice(1);
  $("#profileName").textContent = user.name;
  $("#profileAvatar").textContent = user.name[0].toUpperCase();
  $("#profileDetails").innerHTML = `<dt>Role</dt><dd>${esc(user.role)}</dd><dt>Email</dt><dd>${esc(user.email)}</dd><dt>School ID</dt><dd>${esc(user.schoolId)}</dd><dt>WhatsApp</dt><dd>${esc(user.whatsapp)}</dd>${user.role === "student" ? `<dt>Class / Grade</dt><dd>${esc(user.classGrade || "Not set")}</dd>` : ""}<dt>Storage</dt><dd>Secure data + file storage</dd>`;
  setDataStatus("Refreshing data…","loading");
  $$(".admin-only").forEach(e => e.classList.toggle("hidden", user.role !== "admin"));
  $$(".regular-only").forEach(e => e.classList.toggle("hidden", user.role === "admin"));
  $(".student-reminder-nav").classList.toggle("hidden",user.role!=="student");
  $$(".teacher-only").forEach(e => e.classList.toggle("hidden", user.role !== "teacher"));
  if (user.role === "admin") {
    $("#dashboardEyebrow").textContent="ADMINISTRATOR";
    if(!adminData) $("#adminUsers").innerHTML='<div class="empty">Loading accounts and totals…</div>';
    dashboardController=null;
    await loadAdminDashboard(); return;
  }
  $$(".teacher-only").forEach(e => e.classList.toggle("hidden", user.role !== "teacher"));
  $$(".student-only").forEach(e => e.classList.toggle("hidden", user.role !== "student"));
  renderReminders([]);
  $("#dashboardEyebrow").textContent = user.role.toUpperCase() + " DASHBOARD";
  const cachedDashboard = loadDashboardCache(user);
  if (cachedDashboard) applyDashboardData(user, cachedDashboard);
  else {
    $("#reminderList").innerHTML = '<div class="empty">Loading reminder setup…</div>';
    containers.forEach(e => e.innerHTML = '<div class="empty">Loading exams and files…</div>');
  }
  try {
    const result = await apiGet("listExams", { signal: controller.signal });
    if (version !== sessionVersion || !currentUser || currentUser.email !== user.email) return;
    applyDashboardData(user, result);
    saveDashboardCache(user, result);
    setDataStatus("Updated " + new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) + " · Data is up to date.");
  } catch (error) {
    if (error.name === "AbortError" || version !== sessionVersion) return;
    if (isSessionError(error)) { showPublic(); toast("Your secure session expired. Please log in again."); return; }
    if (cachedDashboard) {
      setDataStatus("Refresh unavailable. Showing saved data—it may be outdated.","saved");
      toast("Showing saved data");
    } else {
      setDataStatus("Could not refresh. Check your connection and try Refresh data.","error");
      containers.forEach(e => e.innerHTML = `<div class="empty">Could not load data after retrying: ${esc(friendly(error))}</div>`);
      $("#reminderList").innerHTML = `<div class="empty">Could not load reminders after retrying: ${esc(friendly(error))}</div>`;
      $("#statExams").textContent = "—";
      $("#statDays").textContent = "—";
    }
  } finally {
    if (dashboardController === controller) dashboardController = null;
  }
}
function newStudyTaskId() {
  return (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^a-zA-Z0-9-]/g, "");
}
function openStudyPlanModal() {
  if (currentUser?.role !== "student") return;
  const form = $("#studyPlanForm");
  form.reset();
  $("#studyPlanError").textContent = "";
  $("#studyPlanTaskInputs").innerHTML = "";
  addStudyPlanTaskInput();
  modal("studyPlanModal");
}
function addStudyPlanTaskInput() {
  const box = $("#studyPlanTaskInputs");
  if (!box || box.children.length >= 30) return toast("A plan can have up to 30 tasks.");
  const row = document.createElement("div");
  row.className = "study-plan-task-input";
  row.innerHTML = `<label><span class="sr-only">Specific study task</span><input name="taskText" type="text" maxlength="200" placeholder="Learn one specific topic or task"></label><button class="small-action delete-action" type="button" data-remove-plan-task-input aria-label="Remove task input">×</button>`;
  box.appendChild(row);
  row.querySelector("input").focus();
}
function renderStudyPlans() {
  const list = $("#studyPlansList");
  if (!list) return;
  if (!loadedStudyPlans.length) {
    list.innerHTML = '<div class="empty">No study plans yet. Click “Add a plan” to make your first one.</div>';
    return;
  }
  list.innerHTML = loadedStudyPlans.map(plan => {
    const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
    const done = tasks.filter(task => task.completed).length;
    const taskHtml = tasks.length ? `<ul class="study-task-list">${tasks.map(task => {
      const stamp = task.completedAt ? new Date(task.completedAt) : null;
      const completion = stamp && !Number.isNaN(stamp.getTime()) ? `Completed at ${esc(stamp.toLocaleString([], {dateStyle:"medium",timeStyle:"short"}))}` : "";
      return `<li class="study-task-row"><label class="study-task-check"><input type="checkbox" data-study-task-checkbox data-plan-id="${esc(plan.id)}" data-task-id="${esc(task.id)}" ${task.completed ? "checked" : ""} ${studyPlanMutationBusy ? "disabled" : ""}><span>${esc(task.text)}</span></label>${completion ? `<small class="study-task-completed">${completion}</small>` : ""}<button class="small-action delete-action" type="button" data-plan-action="remove-task" data-plan-id="${esc(plan.id)}" data-task-id="${esc(task.id)}" ${studyPlanMutationBusy ? "disabled" : ""} aria-label="Remove task: ${esc(task.text)}">Remove</button></li>`;
    }).join("")}</ul>` : '<p class="muted">No specific tasks yet. Add one below.</p>';
    return `<article class="study-plan-card"><div class="study-plan-head"><div><h3>${esc(plan.title)}</h3><p class="study-plan-progress">${done} of ${tasks.length} tasks complete</p></div><button class="small-action delete-action" type="button" data-plan-action="delete" data-plan-id="${esc(plan.id)}" ${studyPlanMutationBusy ? "disabled" : ""}>Delete plan</button></div>${taskHtml}<form class="study-plan-add-form" data-plan-add-form data-plan-id="${esc(plan.id)}"><label><span class="sr-only">Add a specific study task</span><input name="taskText" type="text" maxlength="200" required placeholder="Add one specific topic or task…" ${studyPlanMutationBusy ? "disabled" : ""}></label><button class="button button-secondary" type="submit" ${studyPlanMutationBusy ? "disabled" : ""}>+ Add task</button></form></article>`;
  }).join("");
}
async function loadStudyPlans(force = false) {
  if (currentUser?.role !== "student" || studyPlansLoading) return;
  if (studyPlansLoaded && !force) { renderStudyPlans(); return; }
  const user = currentUser, version = sessionVersion;
  studyPlansLoading = true;
  $("#studyPlansError").textContent = "";
  $("#studyPlansList").innerHTML = '<div class="empty">Loading your study plans…</div>';
  try {
    const result = await apiGet("listStudyPlans");
    if (version !== sessionVersion || currentUser?.email !== user.email) return;
    loadedStudyPlans = Array.isArray(result.plans) ? result.plans : [];
    studyPlansLoaded = true;
    renderStudyPlans();
  } catch (error) {
    if (version === sessionVersion) {
      $("#studyPlansError").textContent = friendly(error);
      $("#studyPlansList").innerHTML = '<div class="empty">Could not load your plans. Try Refresh.</div>';
    }
  } finally {
    if (version === sessionVersion) studyPlansLoading = false;
  }
}
async function saveNewStudyPlan(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (currentUser?.role !== "student" || form.dataset.sending === "true" || studyPlanMutationBusy) return;
  const title = String(form.elements.title.value || "").trim();
  const taskTexts = [...form.querySelectorAll('[name="taskText"]')].map(input => String(input.value || "").trim()).filter(Boolean);
  const error = $("#studyPlanError");
  error.textContent = "";
  if (!title || title.length > 100) { error.textContent = "Enter a plan name of 1 to 100 characters."; return; }
  if (!taskTexts.length) { error.textContent = "Add at least one specific task to this plan."; return; }
  if (taskTexts.length > 30 || taskTexts.some(text => text.length > 200)) { error.textContent = "Use up to 30 tasks, with no more than 200 characters per task."; return; }
  const user = currentUser, version = sessionVersion;
  studyPlanMutationBusy = true;
  busy(form, true, "Saving plan…");
  try {
    const result = await apiPost("saveStudyPlan", { title, tasks: taskTexts.map(text => ({id:newStudyTaskId(),text,completed:false})) });
    if (version !== sessionVersion || currentUser?.email !== user.email) return;
    loadedStudyPlans = [result.plan, ...loadedStudyPlans];
    studyPlansLoaded = true;
    renderStudyPlans();
    form.reset();
    closeDialogs();
    toast("Study plan saved");
  } catch (error) {
    if (version === sessionVersion) $("#studyPlanError").textContent = friendly(error);
  } finally {
    if (version === sessionVersion) {
      studyPlanMutationBusy = false;
      busy(form, false);
      renderStudyPlans();
    }
  }
}
async function persistStudyPlan(plan, tasks) {
  if (studyPlanMutationBusy) return false;
  const user = currentUser, version = sessionVersion;
  studyPlanMutationBusy = true;
  $("#studyPlansError").textContent = "";
  try {
    const result = await apiPost("saveStudyPlan", { planId: plan.id, title: plan.title, tasks });
    if (version !== sessionVersion || currentUser?.email !== user.email) return false;
    loadedStudyPlans = loadedStudyPlans.map(item => item.id === result.plan.id ? result.plan : item);
    renderStudyPlans();
    return true;
  } catch (error) {
    if (version === sessionVersion) $("#studyPlansError").textContent = friendly(error);
    return false;
  } finally {
    if (version === sessionVersion) { studyPlanMutationBusy = false; renderStudyPlans(); }
  }
}
async function toggleStudyTask(planId, taskId, completed) {
  const plan = loadedStudyPlans.find(item => item.id === planId);
  if (!plan || studyPlanMutationBusy) { renderStudyPlans(); return; }
  const tasks = plan.tasks.map(task => task.id === taskId ? {...task, completed} : {...task});
  const saved = await persistStudyPlan(plan, tasks);
  if (saved && completed) toast("Task completed");
  if (!saved) renderStudyPlans();
}
async function addStudyPlanTask(form) {
  const plan = loadedStudyPlans.find(item => item.id === form.dataset.planId);
  const input = form.elements.taskText, text = String(input.value || "").trim();
  if (!plan || !text || studyPlanMutationBusy) return;
  if (text.length > 200) { $("#studyPlansError").textContent = "Keep each task under 200 characters."; return; }
  if (plan.tasks.length >= 30) { $("#studyPlansError").textContent = "A plan can have up to 30 tasks."; return; }
  const saved = await persistStudyPlan(plan, [...plan.tasks, {id:newStudyTaskId(),text,completed:false,completedAt:""}]);
  if (saved) toast("Task added");
}
async function removeStudyPlanTask(planId, taskId) {
  const plan = loadedStudyPlans.find(item => item.id === planId);
  if (!plan || studyPlanMutationBusy) return;
  const tasks = plan.tasks.filter(task => task.id !== taskId);
  await persistStudyPlan(plan, tasks);
}
async function deleteStudyPlan(planId) {
  const plan = loadedStudyPlans.find(item => item.id === planId);
  if (!plan || studyPlanMutationBusy || !confirm(`Delete the plan “${plan.title}” and its tasks?`)) return;
  const user = currentUser, version = sessionVersion;
  studyPlanMutationBusy = true;
  $("#studyPlansError").textContent = "";
  try {
    await apiPost("deleteStudyPlan", { planId });
    if (version !== sessionVersion || currentUser?.email !== user.email) return;
    loadedStudyPlans = loadedStudyPlans.filter(item => item.id !== planId);
    renderStudyPlans();
    toast("Study plan deleted");
  } catch (error) {
    if (version === sessionVersion) $("#studyPlansError").textContent = friendly(error);
  } finally {
    if (version === sessionVersion) { studyPlanMutationBusy = false; renderStudyPlans(); }
  }
}
function showDashboard() {
  $$(".public-view").forEach((e) => e.classList.add("hidden"));
  $("#dashboard").classList.remove("hidden");
  $(".nav-actions").classList.add("hidden");
  switchTab(currentUser?.role === "admin" ? "admin" : "overview");
  $(".student-reminder-nav").classList.toggle("hidden",currentUser?.role!=="student");
  renderSettings();renderDashboard();
  scrollTo(0, 0);
}
function showPublic() {
  clearSession();
  closeDialogs();
  $("#dashboard").classList.add("hidden");
  $$(".public-view").forEach(e => e.classList.remove("hidden"));
  $(".nav-actions").classList.remove("hidden");
  $("#loginForm").reset();
  $("#loginError").textContent = "";
  scrollTo(0, 0);
}
function switchTab(tab) {
  if (currentUser?.role === "admin" && !["admin","profile","settings"].includes(tab)) tab="admin";
  if (currentUser?.role !== "admin" && tab === "admin") tab="overview";
  if(currentUser?.role!=="student" && ["reminders","studyPlans"].includes(tab))tab="overview";
  if(tab==="settings")renderSettings();
  $$(".tab-panel").forEach((e) => e.classList.add("hidden"));
  $("#" + tab + "Tab").classList.remove("hidden");
  $$(".side-nav button").forEach((e) =>
    e.classList.toggle("active", e.dataset.tab === tab),
  );
  $("#dashboardTitle").textContent = {
    settings: "Settings",
    feedback: "Send feedback",
    admin: "Administrator dashboard",
    overview: "Your overview",
    exams: "Exam schedule",
    reminders: "Exam reminders",
    studyPlans: "Study Plans",
    chat: "AI study assistant",
    profile: "Your profile",
  }[tab];
  if (tab === "chat") loadChatHistory();
  if (tab === "studyPlans") loadStudyPlans();
}
async function restoreSession() {
  const generation = ++restoreGeneration;
  localStorage.removeItem("examready_google_session");
  localStorage.removeItem("examready_remembered_session");
  sessionStorage.removeItem("examready_session");
  const tabSession = sessionStorage.getItem(TAB_SESSION_KEY);
  if (tabSession) {
    try {
      const saved = JSON.parse(tabSession);
      if (generation !== restoreGeneration || manualLoginStarted) return;
      if (saved?.account?.email && saved?.sessionToken) { setSession(saved.account, saved.sessionToken); showDashboard(); return; }
    } catch {}
    sessionStorage.removeItem(TAB_SESSION_KEY);
  }
  const rememberedText = localStorage.getItem(REMEMBERED_SESSION_KEY);
  if (!rememberedText || generation !== restoreGeneration || manualLoginStarted) return;
  try {
    const remembered = JSON.parse(rememberedText);
    if (!remembered?.sessionToken) throw Error("Missing remembered session");
    const restored = await apiPost("resumeSession", { sessionToken: remembered.sessionToken });
    if (generation !== restoreGeneration || manualLoginStarted) {
      apiPost("logout", { sessionToken: restored.sessionToken }).catch(() => {});
      return;
    }
    setSession(restored.account, restored.sessionToken);
    showDashboard();
  } catch {
    if (generation === restoreGeneration) {
      localStorage.removeItem(REMEMBERED_SESSION_KEY);
      sessionStorage.removeItem(TAB_SESSION_KEY);
    }
  }
}
function init() {
  restoreSession();
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button,.brand");
    if (b?.classList.contains("click-sound")) beep();
    if(b?.id==="forgotPasswordBtn"){beginManualLogin();closeDialogs();openPasswordReset();}
    if(b?.id==="resetResendBtn") resendResetCode();
    if(b?.id==="resetStartAgain" && !resetBusy){clearPasswordReset();resetFormView();}
    if(b?.id==="resetBackLogin" && !resetBusy){closeDialogs();modal("loginModal");}
    if(b?.id==="resendEmailCode") resendEmailCode();
    if(b?.id==="changeVerificationEmail" && !verificationBusy){clearEmailVerification();closeDialogs();modal("signupModal");}
    if (b?.dataset.open) {
      if (b.dataset.open === "loginModal" || b.dataset.open === "signupModal") beginManualLogin();
      if (b.dataset.role) selectRole(b.dataset.role);
      if(b.dataset.open==="signupModal" && pendingEmailVerification)openEmailVerification();
      else modal(b.dataset.open);
    }
    if (b?.dataset.pickRole) selectRole(b.dataset.pickRole);
    if (b?.hasAttribute("data-close")) b.closest("dialog").close();
    if (b?.dataset.tab) switchTab(b.dataset.tab);
    if (b?.dataset.adminAction) changeAdminAccount(b);
    if (b?.dataset.feedbackStatus) updateFeedbackStatus(b);
    if (b?.id === "adminRefresh") loadAdminDashboard();
    if (b?.id === "dashboardRefresh") renderDashboard();
    if (b?.dataset.examAction === "edit") openEditExam(b.dataset.examId);
    if (b?.dataset.examAction === "delete") removeExam(b.dataset.examId);
    if (b?.dataset.reminderExamId) openEditExam(b.dataset.reminderExamId);
    if (b?.id === "addStudyPlanBtn") openStudyPlanModal();
    if (b?.id === "studyPlansRefresh") loadStudyPlans(true);
    if (b?.id === "addStudyPlanTaskInput") addStudyPlanTaskInput();
    if (b?.hasAttribute("data-remove-plan-task-input")) {
      b.closest(".study-plan-task-input")?.remove();
      if (!$("#studyPlanTaskInputs").children.length) addStudyPlanTaskInput();
    }
    if (b?.dataset.planAction === "delete") deleteStudyPlan(b.dataset.planId);
    if (b?.dataset.planAction === "remove-task") removeStudyPlanTask(b.dataset.planId, b.dataset.taskId);
    if (b?.dataset.chatPrompt) {
      switchTab("chat");
      const chatInput = $("#chatInput");
      chatInput.value = b.dataset.chatPrompt;
      if (b.dataset.studyExamId) chatInput.dataset.examId = b.dataset.studyExamId;
      else delete chatInput.dataset.examId;
      chatInput.focus();
    }
  });
  $$("dialog").forEach((d) =>
    d.addEventListener("click", (e) => {
      if (e.target === d) d.close();
    }),
  );
  $("#studentSettingsForm").addEventListener("submit",savePersonalReminders);
  $("#studyPlanForm").addEventListener("submit",saveNewStudyPlan);
  $("#studyPlansList").addEventListener("change",event=>{
    const checkbox=event.target.closest("[data-study-task-checkbox]");
    if(checkbox)toggleStudyTask(checkbox.dataset.planId,checkbox.dataset.taskId,checkbox.checked);
  });
  $("#studyPlansList").addEventListener("submit",event=>{
    const form=event.target.closest("[data-plan-add-form]");
    if(form){event.preventDefault();addStudyPlanTask(form);}
  });
  $("#settingsTheme").addEventListener("change",e=>setTheme(e.target.value));
  $("#settingsSound").addEventListener("change",e=>{soundOn=e.target.checked;saveSoundPreference();});
  $("#settingsPasswordReset").addEventListener("click",()=>{if(!confirm("Password recovery signs you out on this device. Continue?"))return;const email=currentUser.email;showPublic();$("#loginForm [name=email]").value=email;beginManualLogin();openPasswordReset();});
  $("#requestResetForm").addEventListener("submit",requestResetCode);
  $("#finishResetForm").addEventListener("submit",saveNewPassword);
  $("#verifyEmailForm").addEventListener("submit",verifySchoolEmail);
  $("#feedbackForm").addEventListener("submit",sendFeedback);
  $("#feedbackMessage").addEventListener("input",()=>$("#feedbackLength").textContent=$("#feedbackMessage").value.length+" / 1500");
  $("#feedbackFilter").addEventListener("change",()=>{if(adminData && currentUser?.role==="admin")renderFeedbackInbox(adminData)});
  $("#signupForm").addEventListener("submit", signup);
  $("#loginForm").addEventListener("submit", login);
  $("#examForm").addEventListener("submit", saveExam);
  $("#chatForm").addEventListener("submit", sendChat);
  $("#clearChatBtn").addEventListener("click", clearChat);
  $("#examForm [name=attachment]").addEventListener("change", (e) => {
    $("#fileName").textContent = e.target.files[0]?.name || "No file selected";
  });
  $("#newExamBtn").addEventListener("click", openCreateExam);
  $("#logoutBtn").addEventListener("click", logout);
  $("#soundToggle").addEventListener("click", (e) => {
    soundOn = !soundOn;saveSoundPreference();
    e.currentTarget.textContent = soundOn ? "♫" : "×";
    toast(soundOn ? "Click sounds on" : "Click sounds off");
  });
}

let adminData = null, adminLoading = false, adminBusy = false, adminLoadId = 0;
function renderAdminData(data) {
  adminData = data;
  const t=data.totals;
  $("#adminStats").innerHTML = [["Students",t.students],["Teachers",t.teachers],["Pending approvals",t.pending],["Upcoming exams",t.upcoming]].map(([label,n])=>`<article><small>${esc(label)}</small><strong>${Number(n)}</strong></article>`).join("");
  const users=data.users.filter(x=>`${x.name} ${x.email} ${x.role}`.toLowerCase().includes($("#adminSearch").value.toLowerCase()));
  $("#adminUsers").innerHTML = users.length ? users.map(u=>`<article class="admin-user"><div><h3>${esc(u.name)}</h3><p>${esc(u.email)}</p><p>${esc(u.role)} · ${esc(u.classGrade || u.schoolId || "")} · <b>${esc(u.accountStatus)}</b>${u.role==="teacher" ? " · "+esc(u.approvalStatus) : ""}${u.isAdmin ? " · Owner" : ""}</p></div><div class="admin-actions">${u.isAdmin ? '<span class="muted">Protected owner</span>' : `${u.role==="teacher" && u.approvalStatus==="pending" ? `<button class="button button-secondary" data-admin-action="approved" data-id="${esc(u.id)}" data-role="teacher">Approve</button><button class="button button-secondary" data-admin-action="rejected" data-id="${esc(u.id)}" data-role="teacher">Reject</button>` : ""}<button class="button button-secondary" data-admin-action="${u.accountStatus==="disabled" ? "active" : "disabled"}" data-id="${esc(u.id)}" data-role="${esc(u.role)}">${u.accountStatus==="disabled" ? "Enable" : "Disable"}</button>`}</div></article>`).join("") : '<div class="empty">No matching accounts.</div>';
  $("#adminExams").innerHTML = data.upcoming.length ? data.upcoming.map(e=>`<article class="admin-user"><div><h3>${esc(e.title)}</h3><p>${esc(e.subject)} · ${esc(e.classGrade)} · ${esc(new Date(e.examAt).toLocaleString())}</p></div></article>`).join("") : '<div class="empty">No upcoming exams.</div>';
  renderFeedbackInbox(data);
  $("#adminUpdated").textContent = "Updated " + new Date(data.checkedAt).toLocaleTimeString() + " · " + Number(t.disabled) + " disabled accounts";
  $("#adminError").textContent="";
  setDataStatus("Administrator data is up to date.");
}
async function loadAdminDashboard() {
  if (currentUser?.role !== "admin" || adminLoading || adminBusy) return;
  const version=sessionVersion, id=++adminLoadId;
  adminLoading=true; $("#adminRefresh").disabled=true;
  $("#adminUpdated").textContent="Refreshing data…";
  setDataStatus("Refreshing administrator data…","loading");
  try {
    let data;
    for(let attempt=0;attempt<3;attempt++) {
      try {data=await apiPost("adminDashboard");break;}
      catch(error) {if(error.serverRejected || attempt===2)throw error;await wait(250+attempt*300);}
    }
    if (version===sessionVersion && id===adminLoadId && currentUser?.role==="admin") renderAdminData(data);
  } catch(error) {
    if(version!==sessionVersion)return;
    setDataStatus("Refresh failed. Existing data may be outdated.","error");
    $("#adminError").textContent=friendly(error);
    $("#adminUpdated").textContent="Refresh failed. Displayed data may be outdated.";
    if(isSessionError(error)) {showPublic();toast("Please log in again.");}
  } finally {if(id===adminLoadId){adminLoading=false;$("#adminRefresh").disabled=false;}}
}
async function changeAdminAccount(button) {
  if (currentUser?.role!=="admin" || adminBusy || adminLoading) return;
  const action=button.dataset.adminAction;
  if ((action==="disabled" || action==="rejected") && !confirm(action==="disabled" ? "Disable this account? Existing sessions will be revoked." : "Reject this teacher account?")) return;
  const version=sessionVersion; adminBusy=true;
  $$("#adminTab button").forEach(b=>b.disabled=true);
  $("#adminError").textContent="";
  const body={id:button.dataset.id,role:button.dataset.role};
  body[["approved","rejected"].includes(action) ? "approvalStatus" : "accountStatus"]=action;
  try {
    const data=await apiPost("adminAccount",body);
    if(version!==sessionVersion || currentUser?.role!=="admin")return;
    renderAdminData(data);toast("Account updated");
  } catch(error) {if(version===sessionVersion)$("#adminError").textContent=friendly(error);}
  finally {if(version===sessionVersion){adminBusy=false;$$("#adminTab button").forEach(b=>b.disabled=false);}}
}
document.querySelector("#adminSearch").addEventListener("input",()=>{if(adminData && currentUser?.role==="admin")renderAdminData(adminData)});

const themeMedia = matchMedia("(prefers-color-scheme: dark)");
function setTheme(theme, save = true) {
  document.documentElement.dataset.theme=theme;
  if(save)try{localStorage.setItem("examready_theme",theme)}catch{}
  const button=$("#themeToggle");
  const sun='<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>';
  const moon='<path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10Z"/>';
  button.innerHTML=`<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">${theme==="dark" ? sun : moon}</svg><span class="theme-label">${theme==="dark" ? "Light" : "Dark"}</span>`;
  button.setAttribute("aria-label",theme==="dark" ? "Switch to light theme" : "Switch to dark theme");
}
setTheme(document.documentElement.dataset.theme || (themeMedia.matches ? "dark" : "light"),false);
$("#themeToggle").addEventListener("click",()=>setTheme(document.documentElement.dataset.theme==="dark" ? "light" : "dark"));
themeMedia.addEventListener("change",event=>{let preference=null;try{preference=localStorage.getItem("examready_theme")}catch{}if(!preference)setTheme(event.matches ? "dark" : "light",false)});
function setDataStatus(text, state="ready") {
  $("#dataStatus").textContent=text;
  $("#dataStatus").dataset.state=state;
}

const feedbackCategories={problem:"Something is broken",slow:"Slow response",suggestion:"Suggestion",general:"General feedback"};
async function sendFeedback(event) {
  event.preventDefault();
  const form=event.currentTarget, user=currentUser,version=sessionVersion;
  if(!user || !["student","teacher"].includes(user.role) || form.dataset.sending==="true")return;
  const data=Object.fromEntries(new FormData(form));
  $("#feedbackError").textContent="";$("#feedbackSuccess").classList.add("hidden");
  busy(form,true,"Sending feedback…");
  try {
    const result=await apiPost("submitFeedback",{category:data.category,title:data.title.trim(),message:data.message.trim()});
    if(version!==sessionVersion || currentUser?.email!==user.email)return;
    form.reset();$("#feedbackLength").textContent="0 / 1500";
    $("#feedbackSuccess").textContent="Thank you—your feedback was saved for the administrator. Reference: "+result.feedbackId;
    $("#feedbackSuccess").classList.remove("hidden");toast("Feedback received");
  } catch(error) {
    if(version===sessionVersion)$("#feedbackError").textContent=friendly(error);
  } finally {if(version===sessionVersion)busy(form,false);}
}
function renderFeedbackInbox(data) {
  const filter=$("#feedbackFilter").value, reports=data.feedback || [];
  $("#feedbackOpenCount").textContent=Number(data.openFeedback || 0)+" open";
  const visible=reports.filter(r=>filter==="all" || r.status===filter);
  $("#adminFeedbackList").innerHTML=visible.length ? visible.map(r=>`<article class="feedback-report"><div class="feedback-report-head"><div><span class="feedback-tag">${esc(feedbackCategories[r.category] || "Feedback")}</span><h3>${esc(r.title)}</h3></div><span class="feedback-state ${r.status==="resolved" ? "resolved" : ""}">${esc(r.status)}</span></div><p class="feedback-body">${esc(r.message)}</p><div class="feedback-report-foot"><p>${esc(r.name)} · ${esc(r.role)}<br>${esc(r.email)}<br>${esc(new Date(r.createdAt).toLocaleString())}</p><button type="button" class="button button-secondary" data-feedback-status="${r.status==="resolved" ? "open" : "resolved"}" data-feedback-id="${esc(r.id)}">${r.status==="resolved" ? "Reopen" : "Mark resolved"}</button></div></article>`).join("") : '<div class="empty">No '+(filter==="all" ? "" : esc(filter)+" ")+'feedback yet.</div>';
}
async function updateFeedbackStatus(button) {
  if(currentUser?.role!=="admin" || adminBusy || adminLoading)return;
  const version=sessionVersion;adminBusy=true;
  $$("#adminTab button").forEach(b=>b.disabled=true);
  $("#adminError").textContent="";setDataStatus("Saving feedback status…","loading");
  try {
    const data=await apiPost("adminFeedback",{id:button.dataset.feedbackId,status:button.dataset.feedbackStatus});
    if(version===sessionVersion && currentUser?.role==="admin"){renderAdminData(data);toast("Feedback status saved");}
  } catch(error) {
    if(version===sessionVersion){$("#adminError").textContent=friendly(error);setDataStatus("Feedback update could not be confirmed. Refresh data.","error");}
  } finally {if(version===sessionVersion){adminBusy=false;$$("#adminTab button").forEach(b=>b.disabled=false);}}
}

let pendingEmailVerification=null,verificationBusy=false;
const verificationStorageKey=`examready_email_verification_${APP_STORAGE_SCOPE}`;
try{pendingEmailVerification=JSON.parse(sessionStorage.getItem(verificationStorageKey)||"null")}catch{}
function rememberEmailVerification(data) {
  pendingEmailVerification={verificationId:data.verificationId,email:data.email,role:data.role,expiresAt:data.expiresAt,resendAt:data.resendAt};
  try{sessionStorage.setItem(verificationStorageKey,JSON.stringify(pendingEmailVerification))}catch{}
}
function clearEmailVerification() {
  pendingEmailVerification=null;try{sessionStorage.removeItem(verificationStorageKey)}catch{}
}
function openEmailVerification() {
  if(!pendingEmailVerification)return modal("signupModal");
  $("#verificationEmail").textContent=pendingEmailVerification.email;
  $("#verificationError").textContent="";
  $("#verificationInfo").textContent="Check your school inbox and spam folder. The code expires after 10 minutes.";
  modal("verifyEmailModal");updateResendButton();
}
function updateResendButton() {
  const b=$("#resendEmailCode");if(!b || !pendingEmailVerification)return;
  const seconds=Math.max(0,Math.ceil((new Date(pendingEmailVerification.resendAt)-Date.now())/1000));
  $("#changeVerificationEmail").disabled=verificationBusy;
  b.disabled=verificationBusy||seconds>0;
  b.textContent=seconds ? "Resend in "+seconds+"s" : "Resend code";
}
setInterval(updateResendButton,1000);
async function verifySchoolEmail(event) {
  event.preventDefault();const form=event.currentTarget;
  if(verificationBusy || !pendingEmailVerification)return;
  const challenge=pendingEmailVerification.verificationId, version=sessionVersion, generation=restoreGeneration;
  $("#verificationError").textContent="";verificationBusy=true;busy(form,true,"Verifying…");updateResendButton();
  try {
    const result=await apiPost("verifyEmail",{verificationId:challenge,code:form.elements.code.value.trim()});
    if(version!==sessionVersion || generation!==restoreGeneration || pendingEmailVerification?.verificationId!==challenge)return;
    clearEmailVerification();form.reset();$("#signupForm").reset();closeDialogs();
    if(result.role==="teacher"){toast("Email verified. Teacher account is waiting for admin approval.");return;}
    setSession(result.account,result.sessionToken);toast("Email verified. Your account is ready.");showDashboard();
  } catch(error) {if(pendingEmailVerification?.verificationId===challenge)$("#verificationError").textContent=friendly(error);}
  finally {verificationBusy=false;busy(form,false);updateResendButton();}
}
async function resendEmailCode() {
  if(verificationBusy || !pendingEmailVerification || $("#resendEmailCode").disabled)return;
  const challenge=pendingEmailVerification.verificationId;verificationBusy=true;updateResendButton();
  $("#verificationError").textContent="";
  try {
    const result=await apiPost("resendEmailCode",{verificationId:challenge});
    if(pendingEmailVerification?.verificationId!==challenge)return;
    rememberEmailVerification(result);$("#verifyEmailForm").elements.code.value="";
    $("#verificationInfo").textContent="A new code was requested. Only the newest code will work. Check inbox and spam.";
  } catch(error){if(pendingEmailVerification?.verificationId===challenge)$("#verificationError").textContent=friendly(error);}
  finally {verificationBusy=false;updateResendButton();}
}

let pendingPasswordReset=null,resetBusy=false;
const resetStorageKey=`examready_password_reset_${APP_STORAGE_SCOPE}`;
try{pendingPasswordReset=JSON.parse(sessionStorage.getItem(resetStorageKey)||"null")}catch{}
function rememberPasswordReset(data) {
  pendingPasswordReset={resetId:data.resetId,email:data.email,expiresAt:data.expiresAt,resendAt:data.resendAt};
  try{sessionStorage.setItem(resetStorageKey,JSON.stringify(pendingPasswordReset))}catch{}
}
function clearPasswordReset() {pendingPasswordReset=null;try{sessionStorage.removeItem(resetStorageKey)}catch{}}
function resetFormView() {
  $("#requestResetForm").classList.toggle("hidden",!!pendingPasswordReset);
  $("#finishResetForm").classList.toggle("hidden",!pendingPasswordReset);
  $("#resetRequestError").textContent="";$("#resetFinishError").textContent="";
  $("#finishResetForm").reset();
  if(pendingPasswordReset){$("#resetEmail").textContent=pendingPasswordReset.email;$("#resetInfo").textContent="If this email belongs to a registered account, a reset code has been requested. Check inbox and spam. Codes expire in 10 minutes.";}
  updateResetResend();
}
function openPasswordReset() {
  resetFormView();const input=$("#requestResetForm [name=email]");
  if(!pendingPasswordReset)input.value=$("#loginForm [name=email]").value;
  modal("passwordResetModal");
}
function updateResetResend() {
  const b=$("#resetResendBtn");if(!b)return;
  $("#resetStartAgain").disabled=resetBusy;
  $("#resetBackLogin").disabled=resetBusy;
  const seconds=pendingPasswordReset ? Math.max(0,Math.ceil((new Date(pendingPasswordReset.resendAt)-Date.now())/1000)) : 0;
  b.disabled=resetBusy||seconds>0;b.textContent=seconds?"Resend in "+seconds+"s":"Resend code";
}
setInterval(updateResetResend,1000);
async function requestResetCode(event) {
  event.preventDefault();if(resetBusy)return;
  const form=event.currentTarget,generation=restoreGeneration;
  const email=form.elements.email.value.trim().toLowerCase();resetBusy=true;busy(form,true,"Requesting code…");$("#resetRequestError").textContent="";updateResetResend();
  try {
    const result=await apiPost("requestPasswordReset",{email});
    if(generation!==restoreGeneration)return;
    if(!result.passwordResetRequested || !result.resetId)throw Error("Recovery setup is missing. Update your Apps Script deployment.");
    rememberPasswordReset(result);resetFormView();
  } catch(error){if(generation===restoreGeneration)$("#resetRequestError").textContent=friendly(error);}
  finally{resetBusy=false;busy(form,false);updateResetResend();}
}
async function resendResetCode() {
  if(resetBusy || !pendingPasswordReset || $("#resetResendBtn").disabled)return;
  const id=pendingPasswordReset.resetId;resetBusy=true;updateResetResend();$("#resetFinishError").textContent="";
  try {
    const result=await apiPost("resendPasswordReset",{resetId:id,email:pendingPasswordReset.email});
    if(pendingPasswordReset?.resetId!==id)return;
    rememberPasswordReset(result);$("#finishResetForm [name=code]").value="";
    $("#resetInfo").textContent="If eligible, a new code has been requested. Use the newest email code. Check inbox and spam.";
  } catch(error){if(pendingPasswordReset?.resetId===id)$("#resetFinishError").textContent=friendly(error);}
  finally{resetBusy=false;updateResetResend();}
}
async function saveNewPassword(event) {
  event.preventDefault();if(resetBusy || !pendingPasswordReset)return;
  const form=event.currentTarget,password=form.elements.newPassword.value,confirmPassword=form.elements.confirmPassword.value;
  $("#resetFinishError").textContent="";
  if(password!==confirmPassword){$("#resetFinishError").textContent="The two passwords do not match.";return;}
  if(password.trim().length<8){$("#resetFinishError").textContent="Choose a password with at least 8 characters.";return;}
  const id=pendingPasswordReset.resetId,email=pendingPasswordReset.email,generation=restoreGeneration;
  resetBusy=true;busy(form,true,"Changing password…");updateResetResend();
  try {
    const result=await apiPost("resetPassword",{resetId:id,code:form.elements.code.value.trim(),newPassword:password});
    if(generation!==restoreGeneration || pendingPasswordReset?.resetId!==id)return;
    if(!result.passwordReset)throw Error("Password change was not confirmed. Please try logging in or request a new code.");
    clearPasswordReset();form.reset();closeDialogs();showPublic();
    $("#loginForm [name=email]").value=email;$("#loginForm [name=password]").value="";
    $("#loginError").textContent="";modal("loginModal");
    toast("Password changed. Log in with your new password.");
  } catch(error){if(generation===restoreGeneration && pendingPasswordReset?.resetId===id)$("#resetFinishError").textContent=friendly(error);}
  finally{resetBusy=false;busy(form,false);updateResetResend();}
}

function personalReminderPreferences(user=currentUser){const prefs=Object.fromEntries(["reminder7","reminder3","reminder1","reminderDay"].map(k=>[k,user?.[k]===undefined||user?.[k]===null||user?.[k]===""?true:user[k]===true||String(user[k]).toLowerCase()==="true"]));prefs.whatsappOptIn=user?.whatsappOptIn===true||String(user?.whatsappOptIn).toLowerCase()==="true";return prefs;}
function persistSettingsAccount(){if(!currentUser||!currentToken)return;const payload=JSON.stringify({account:currentUser,sessionToken:currentToken});try{sessionStorage.setItem(TAB_SESSION_KEY,payload);const saved=JSON.parse(localStorage.getItem(REMEMBERED_SESSION_KEY)||"null");if(saved?.sessionToken===currentToken)localStorage.setItem(REMEMBERED_SESSION_KEY,payload)}catch{}}
function saveSoundPreference(){try{localStorage.setItem("examready_sound",soundOn?"on":"off")}catch{}$("#soundToggle").textContent=soundOn?"♫":"×";$("#settingsSound").checked=soundOn;}
function renderSettings(){if(!currentUser)return;$("#studentReminderSettings").classList.toggle("hidden",currentUser.role!=="student");const prefs=personalReminderPreferences();Object.keys(prefs).forEach(k=>$("#studentSettingsForm").elements[k].checked=prefs[k]);$("#settingsTheme").value=document.documentElement.dataset.theme||"light";$("#settingsSound").checked=soundOn;$("#settingsAccountEmail").textContent=currentUser.email;$("#studentSettingsError").textContent="";$("#studentSettingsSuccess").textContent="";}
async function savePersonalReminders(event){event.preventDefault();const form=event.currentTarget;if(form.dataset.sending==="true"||currentUser?.role!=="student")return;const user=currentUser,version=sessionVersion,prefs=Object.fromEntries(["reminder7","reminder3","reminder1","reminderDay"].map(k=>[k,form.elements[k].checked]));prefs.whatsappOptIn=form.elements.whatsappOptIn.checked;busy(form,true,"Saving…");$("#studentSettingsError").textContent="";$("#studentSettingsSuccess").textContent="";try{const result=await apiPost("saveStudentSettings",prefs);if(version!==sessionVersion||currentUser?.email!==user.email)return;Object.assign(currentUser,result.preferences);persistSettingsAccount();loadedReminders=result.reminders||[];renderReminders();saveDashboardCache(currentUser,{exams:loadedExams,reminders:loadedReminders,reminderPlans:[],preferences:result.preferences});$("#studentSettingsSuccess").textContent=Object.values(Object.fromEntries(Object.entries(result.preferences).filter(([key])=>key!=="whatsappOptIn"))).some(Boolean)?"Your reminder settings were saved.":"Saved. All your exam reminders are turned off.";}catch(error){if(version===sessionVersion)$("#studentSettingsError").textContent=friendly(error)}finally{if(version===sessionVersion)busy(form,false);}}

init();
saveSoundPreference();
