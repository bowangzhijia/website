/**
 * 文章就地编辑
 *
 * 在文章页上直接改这一篇，不用回写作台。
 * 只有本机存着 GitHub 令牌时，「编辑」按钮才出现——访客看到的页面和以前
 * 一模一样，连按钮都没有。真正的门锁是令牌本身：别人就算摸到这个面板也提交不了。
 *
 * 令牌存在 localStorage 的 bowang-write-token，和写作台共用同一个。
 */
(function () {
  var TOKEN_KEY = 'bowang-write-token';
  var OWNER = 'bowangzhijia';
  var REPO = 'website';
  var BRANCH = 'main';
  var DIR = 'src/content/posts';

  var panel = document.querySelector('[data-edit-panel]');
  var dataEl = document.getElementById('article-data');
  if (!panel || !dataEl) return;

  var post;
  try {
    post = JSON.parse(dataEl.textContent);
  } catch (e) {
    return;
  }
  if (!post) return;

  /** 新建模式：在栏目页上写一篇属于这个栏目的新文章 */
  var isNew = post.mode === 'new';
  if (!isNew && !post.file) return;

  var openBtn = document.querySelector(isNew ? '[data-new-open]' : '[data-edit-open]');
  if (!openBtn) return;

  function token() {
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function todayISO() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  /** 新建模式才存草稿：写到一半关掉页面也不会丢 */
  function draftKey() {
    return 'bowang-new-draft-' + post.column;
  }

  // 没有令牌，就当这个功能不存在
  if (!token()) return;
  openBtn.hidden = false;

  var elTitle = panel.querySelector('[data-edit-title]');
  var elSummary = panel.querySelector('[data-edit-summary]');
  var elDate = panel.querySelector('[data-edit-date]');
  var elBody = panel.querySelector('[data-edit-body]');
  var elMsg = panel.querySelector('[data-edit-msg]');
  var elsSector = Array.prototype.slice.call(panel.querySelectorAll('[data-edit-sector]'));
  var saveBtn = panel.querySelector('[data-edit-save]');
  var delBtn = panel.querySelector('[data-edit-delete]');
  var cancelBtn = panel.querySelector('[data-edit-cancel]');

  var sectorAll = {};
  (post.sectorList || []).forEach(function (s) {
    sectorAll[s.id] = s.name;
  });

  // ---------- 网络 ----------
  function api(path) {
    return 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/' + path;
  }

  function authHeaders(t) {
    return {
      authorization: 'Bearer ' + t,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    };
  }

  /** 单篇文件的直链。带 ref 和时间戳，避免拿到旧缓存里的 sha */
  function fileUrl(path) {
    return api(path) + '?ref=' + BRANCH + '&t=' + Date.now();
  }

  function errText(res) {
    return res
      .json()
      .then(function (j) {
        return j.message || 'HTTP ' + res.status;
      })
      .catch(function () {
        return 'HTTP ' + res.status;
      });
  }

  function yamlStr(s) {
    return '"' + String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  function buildMarkdown(d) {
    var fm = ['---'];
    fm.push('title: ' + yamlStr(d.title));
    if (d.summary) fm.push('summary: ' + yamlStr(d.summary));
    fm.push('date: ' + d.date);
    // 栏目不在这个面板里改，原样保留，避免把文章挪到别的栏目
    fm.push('column: ' + post.column);
    fm.push('sectors: [' + d.sectors.join(', ') + ']');
    fm.push('---');
    return fm.join('\n') + '\n\n' + (d.body || '').trim() + '\n';
  }

  function base64(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  // ---------- 界面 ----------
  function say(text, state) {
    if (!elMsg) return;
    elMsg.textContent = text || '';
    elMsg.dataset.state = state || '';
  }

  function busy(on) {
    if (saveBtn) saveBtn.disabled = on;
    if (delBtn) delBtn.disabled = on;
    if (panel.dataset) panel.dataset.busy = on ? '1' : '0';
  }

  function fill() {
    var current = post.sectors || [];

    if (isNew) {
      var draft = null;
      try {
        draft = JSON.parse(localStorage.getItem(draftKey()) || 'null');
      } catch (e) {}
      if (draft) {
        elTitle.value = draft.title || '';
        elSummary.value = draft.summary || '';
        elDate.value = draft.date || todayISO();
        elBody.value = draft.body || '';
        current = draft.sectors || [];
        say('已恢复上次没发出去的草稿');
      } else {
        elTitle.value = '';
        elSummary.value = '';
        elDate.value = todayISO();
        elBody.value = '';
        current = [];
        say('');
      }
    } else {
      elTitle.value = post.title || '';
      elSummary.value = post.summary || '';
      elDate.value = post.date || post.file;
      elBody.value = post.body || '';
      say('');
    }

    elsSector.forEach(function (box) {
      box.checked = current.indexOf(box.value) >= 0;
    });
  }

  /** 存完之后先把页面上看得见的标题、摘要、日期、行业改掉，不用等网站重新构建 */
  function patchView(d) {
    var title = document.querySelector('.art__title');
    if (title) title.textContent = d.title;

    var summary = document.querySelector('.art__summary');
    if (summary) {
      summary.textContent = d.summary;
      if (d.summary) summary.removeAttribute('hidden');
      else summary.setAttribute('hidden', '');
    }

    var dateEl = document.querySelector('.art__date');
    if (dateEl) {
      var p = String(d.date).split('-');
      dateEl.textContent = Number(p[0]) + '年' + Number(p[1]) + '月' + Number(p[2]) + '日';
      dateEl.setAttribute('datetime', d.date);
    }

    var tags = document.querySelector('.art__tags');
    if (tags) {
      tags.textContent = '';
      d.sectors.forEach(function (id) {
        var li = document.createElement('li');
        li.className = 'art__tag';
        li.textContent = sectorAll[id] || id;
        tags.appendChild(li);
      });
      if (d.sectors.length) tags.removeAttribute('hidden');
      else tags.setAttribute('hidden', '');
    }

    document.title = d.title + ' | 波王之家';
    post.title = d.title;
  }

  function showPanel() {
    panel.hidden = false;
    document.body.style.overflow = 'hidden';
    window.scrollTo({ top: 0 });
  }

  function hidePanel() {
    panel.hidden = true;
    document.body.style.overflow = '';
    say('');
  }

  /** 面板开着时，手机上的返回手势要先关面板，而不是直接离开页面 */
  var historyPushed = false;

  function open() {
    // 先把面板显示出来：万一后面的填充出问题，至少人还能退出去
    showPanel();
    fill();
    try {
      history.pushState({ bowangEditor: 1 }, '');
      historyPushed = true;
    } catch (e) {}
    setTimeout(function () {
      if (elTitle) elTitle.focus();
    }, 80);
  }

  function close() {
    if (panel.hidden) return;
    hidePanel();
    if (historyPushed) {
      historyPushed = false;
      try {
        history.back();
      } catch (e) {}
    }
  }

  // 按了返回键 / 侧滑返回：只关面板，人留在原来那一页
  window.addEventListener('popstate', function () {
    if (!panel.hidden) {
      historyPushed = false;
      hidePanel();
    }
  });

  function collect() {
    return {
      title: elTitle.value.trim(),
      summary: elSummary.value.trim(),
      date: elDate.value,
      sectors: elsSector
        .filter(function (box) {
          return box.checked;
        })
        .map(function (box) {
          return box.value;
        }),
      body: elBody.value.trim(),
    };
  }

  // ---------- 保存 ----------
  async function save() {
    var t = token();
    if (!t) return say('本机没有令牌了，请回写作台重新设置', 'error');

    var d = collect();
    if (!d.title) return say('标题不能为空', 'error');
    if (!d.date) return say('请选择日期', 'error');
    if (!d.body) return say('正文不能为空', 'error');

    busy(true);
    say('正在提交…');

    try {
      // ---------- 新建模式：文件名就是日期，栏目由页面决定 ----------
      if (isNew) {
        var newOnePath = DIR + '/' + d.date + '.md';
        var freshPayload = {
          message: '新增：' + d.title,
          content: base64(buildMarkdown(d)),
          branch: BRANCH,
        };

        var putRes = await fetch(api(newOnePath), {
          method: 'PUT',
          headers: Object.assign({ 'content-type': 'application/json' }, authHeaders(t)),
          body: JSON.stringify(freshPayload),
        });

        // 这一天已经有文章了：GitHub 因为没带 sha 会拒绝，问清楚再覆盖
        if (putRes.status === 409 || putRes.status === 422) {
          var goAhead = confirm(
            d.date + ' 那天已经有文章了。\n\n继续会把原来那篇覆盖掉，确定吗？'
          );
          if (!goAhead) {
            busy(false);
            return say('已取消', '');
          }
          var gotRes = await fetch(fileUrl(newOnePath), { headers: authHeaders(t) });
          if (!gotRes.ok) throw new Error(await errText(gotRes));
          freshPayload.sha = (await gotRes.json()).sha;
          putRes = await fetch(api(newOnePath), {
            method: 'PUT',
            headers: Object.assign({ 'content-type': 'application/json' }, authHeaders(t)),
            body: JSON.stringify(freshPayload),
          });
        }

        if (!putRes.ok) throw new Error(await errText(putRes));

        try {
          localStorage.removeItem(draftKey());
        } catch (e) {}

        busy(false);
        say('已发布，约 1 分钟后会出现在栏目页。', 'ok');
        setTimeout(close, 1500);
        return;
      }

      var oldPath = DIR + '/' + post.file + '.md';
      var newPath = DIR + '/' + d.date + '.md';
      var sameFile = newPath === oldPath;

      // 1) 先拿旧文件的 sha
      var head = await fetch(fileUrl(oldPath), { headers: authHeaders(t) });
      if (head.status === 401) throw new Error('令牌无效或已过期，请回写作台重新设置');
      if (head.status === 403) throw new Error('令牌权限不足，需要「Contents 读写」权限');
      if (!head.ok) throw new Error('读不到原文件（HTTP ' + head.status + '）');
      var oldSha = (await head.json()).sha;

      var payload = {
        message: '更新：' + d.title,
        content: base64(buildMarkdown(d)),
        branch: BRANCH,
      };

      if (sameFile) {
        payload.sha = oldSha;
      } else {
        // 改了日期 = 换文件名，先确认那一天没有被占用
        var dup = await fetch(fileUrl(newPath), { headers: authHeaders(t) });
        if (dup.ok) {
          var go = confirm(
            d.date + ' 那天已经有一篇文章了。\n\n继续会把原来那篇覆盖掉，确定吗？'
          );
          if (!go) {
            busy(false);
            return say('已取消，日期没有改动', '');
          }
          payload.sha = (await dup.json()).sha;
        }
      }

      // 2) 写新文件
      var put = await fetch(api(newPath), {
        method: 'PUT',
        headers: Object.assign({ 'content-type': 'application/json' }, authHeaders(t)),
        body: JSON.stringify(payload),
      });
      if (!put.ok) throw new Error(await errText(put));

      // 3) 改了日期的话，把旧文件删掉
      if (!sameFile) {
        var drop = await fetch(api(oldPath), {
          method: 'DELETE',
          headers: Object.assign({ 'content-type': 'application/json' }, authHeaders(t)),
          body: JSON.stringify({
            message: '改日期：' + post.file + ' → ' + d.date,
            sha: oldSha,
            branch: BRANCH,
          }),
        });
        if (!drop.ok) {
          throw new Error('新内容已保存，但旧的 ' + post.file + '.md 没删掉：' + (await errText(drop)));
        }
        post.file = d.date;
      }

      patchView(d);
      busy(false);
      say('已保存，约 1 分钟后整页更新。', 'ok');
      setTimeout(close, 1000);
    } catch (e) {
      busy(false);
      say('保存失败：' + (e && e.message ? e.message : e), 'error');
    }
  }

  // ---------- 删除 ----------
  async function remove() {
    var t = token();
    if (!t) return say('本机没有令牌了，请回写作台重新设置', 'error');
    if (
      !confirm(
        '确定删除《' + (post.title || post.file) + '》吗？\n\n约 1 分钟后网站更新。这一步不可撤销，但 Git 里留有历史记录。'
      )
    )
      return;

    busy(true);
    say('正在删除…');

    try {
      var path = DIR + '/' + post.file + '.md';
      var head = await fetch(fileUrl(path), { headers: authHeaders(t) });
      if (!head.ok) throw new Error(await errText(head));
      var sha = (await head.json()).sha;

      var res = await fetch(api(path), {
        method: 'DELETE',
        headers: Object.assign({ 'content-type': 'application/json' }, authHeaders(t)),
        body: JSON.stringify({
          message: '删除：' + (post.title || post.file),
          sha: sha,
          branch: BRANCH,
        }),
      });
      if (!res.ok) throw new Error(await errText(res));

      say('已删除，正在返回列表…', 'ok');
      setTimeout(function () {
        location.href = '/columns/' + post.column + '/';
      }, 900);
    } catch (e) {
      busy(false);
      say('删除失败：' + (e && e.message ? e.message : e), 'error');
    }
  }

  // ---------- 事件 ----------
  // 新建模式：边写边存草稿，写到一半把面板关掉也不会丢
  if (isNew) {
    var draftTimer = null;
    var saveDraftSoon = function () {
      clearTimeout(draftTimer);
      draftTimer = setTimeout(function () {
        try {
          localStorage.setItem(draftKey(), JSON.stringify(collect()));
        } catch (e) {}
      }, 400);
    };
    panel.addEventListener('input', saveDraftSoon);
    panel.addEventListener('change', saveDraftSoon);
  }

  openBtn.addEventListener('click', open);
  if (cancelBtn) cancelBtn.addEventListener('click', close);
  if (saveBtn) saveBtn.addEventListener('click', save);
  if (delBtn) delBtn.addEventListener('click', remove);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !panel.hidden) close();
  });

  // 在面板里用 ⌘/Ctrl + Enter 直接保存，电脑上顺手
  panel.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  });
})();
