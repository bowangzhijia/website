/**
 * 写作台门禁（浅浅保密）
 *
 * 说明：这是前端校验，作用是「防止访客顺手发现后台」，
 * 不是真正的安全措施——真正的门锁是 GitHub 令牌。
 * 代码里只存密码的 SHA-256 哈希，不存明文。
 *
 * 想改密码：把新日期的 SHA-256 换到 PASS_HASH 即可。
 * （浏览器控制台或 PowerShell 都能算）
 */
(function () {
  var KEY = 'bowang-unlocked';
  var PASS_HASH = 'c707bfb00ad5d8076b8bdf273c431ccebd9517b081fe90d73150f0a2b6e2b1af';

  function sha256Hex(text) {
    var data = new TextEncoder().encode(text);
    return crypto.subtle.digest('SHA-256', data).then(function (buf) {
      return Array.prototype.map
        .call(new Uint8Array(buf), function (b) {
          return b.toString(16).padStart(2, '0');
        })
        .join('');
    });
  }

  window.BowangAuth = {
    /** 输入的日期是否等于预设密码 */
    check: function (value) {
      var v = String(value || '').trim();
      if (!v) return Promise.resolve(false);
      return sha256Hex(v)
        .then(function (hex) {
          return hex === PASS_HASH;
        })
        .catch(function () {
          return false;
        });
    },

    /** 本次会话是否已通过（关闭浏览器后失效） */
    unlocked: function () {
      try {
        return sessionStorage.getItem(KEY) === '1';
      } catch (e) {
        return false;
      }
    },

    mark: function () {
      try {
        sessionStorage.setItem(KEY, '1');
      } catch (e) {}
    },

    lock: function () {
      try {
        sessionStorage.removeItem(KEY);
      } catch (e) {}
    },
  };
})();
