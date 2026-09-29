/**
 * 「立即抓热点」按钮
 *
 * 在网站上点一下，就让 GitHub 立刻跑一次「每日热点速览」工作流，
 * 不用专门跑到 GitHub 的 Actions 页面去点。
 *
 * 原理：调 GitHub 的 workflow_dispatch 接口触发，然后盯着这次运行的结果，
 * 把进度直接显示在按钮下面。
 *
 * 前提：本机存的 GitHub 令牌必须带「Actions: Read and write」权限，
 * 否则 GitHub 会拒绝。跟发布文章用的是同一个令牌。
 */
(function () {
  var TOKEN_KEY = 'bowang-write-token';
  var OWNER = 'bowangzhijia';
  var REPO = 'website';
  var WORKFLOW = 'hot-news.yml';
  var BRANCH = 'main';

  /** 每隔多久看一次进度、最多看多久 */
  var POLL_MS = 10000;
  var POLL_MAX = 24;

  var btn = document.querySelector('[data-hotnews]');
  var msg = document.querySelector('[data-hotnews-msg]');
  if (!btn || !msg) return;

  function token() {
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  // 没令牌就当这个按钮不存在：访客看到的页面和以前一模一样
  if (!token()) return;
  btn.hidden = false;

  var api = 'https://api.github.com/repos/' + OWNER + '/' + REPO;

  function say(text, state) {
    msg.textContent = text || '';
    if (state) msg.dataset.state = state;
    else delete msg.dataset.state;
  }

  function headers() {
    return {
      authorization: 'Bearer ' + token(),
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    };
  }

  var timer = null;
  var ticks = 0;

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function done(state, text) {
    stop();
    btn.disabled = false;
    say(text, state);
  }

  /** 拉最近一次运行，看它跑到哪了 */
  async function poll(since) {
    var res = await fetch(
      api + '/actions/workflows/' + WORKFLOW + '/runs?per_page=1&t=' + Date.now(),
      { headers: headers() }
    );
    if (!res.ok) return;

    var data = await res.json();
    var run = data && data.workflow_runs && data.workflow_runs[0];
    if (!run) return;

    // 只认这次点击之后产生的那次运行，别把上一轮的旧结果当成自己的
    if (new Date(run.created_at).getTime() < since - 120000) return;

    if (run.status !== 'completed') {
      say(run.status === 'queued' ? '排队中…' : '正在抓取并构建…', 'busy');
      return;
    }

    if (run.conclusion === 'success') {
      done('ok', '✅ 跑完了。刷新页面看看——如果今天已经有文章，这次会被跳过。');
    } else {
      done('error', '❌ 这次失败了。去 Actions 看日志：' + run.html_url);
    }
  }

  btn.addEventListener('click', async function () {
    btn.disabled = true;
    say('正在触发…', 'busy');

    var since = Date.now();

    try {
      var res = await fetch(api + '/actions/workflows/' + WORKFLOW + '/dispatches', {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, headers()),
        body: JSON.stringify({ ref: BRANCH }),
      });

      if (res.status === 204) {
        say('已触发，正在抓取…（约 2 分钟，先别关页面）', 'busy');
        stop();
        ticks = 0;
        timer = setInterval(function () {
          ticks++;
          if (ticks > POLL_MAX) {
            done('', '等太久了，自己去 Actions 看吧：github.com/' + OWNER + '/' + REPO + '/actions');
            return;
          }
          poll(since);
        }, POLL_MS);
        poll(since);
        return;
      }

      if (res.status === 401) {
        done('error', '令牌无效或已过期，回写作台的「GitHub 令牌」重新设置一次。');
        return;
      }

      if (res.status === 403) {
        done('error', '令牌权限不够：去 GitHub 给令牌加上「Actions: Read and write」。');
        return;
      }

      if (res.status === 404) {
        done('error', '找不到这个工作流，或者令牌没有这个仓库的权限。');
        return;
      }

      done('error', '触发失败：HTTP ' + res.status);
    } catch (e) {
      done('error', '触发失败：' + (e && e.message ? e.message : e));
    }
  });
})();
