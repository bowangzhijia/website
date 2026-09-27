/**
 * 写作台门禁（浅浅保密）
 *
 * 说明：这是前端校验，作用是「防止访客顺手发现后台」，
 * 不是真正的安全措施——真正的门锁是 GitHub 令牌。
 * 代码里只存密码的 SHA-256 哈希，不存明文。
 *
 * 填对一次之后，本机会永久记住（存在 localStorage），
 * 下次直接进，不用再填。换了设备或清了浏览数据才需要重填。
 * 想手动清掉：在写作台点右上角「退出设置」。
 *
 * 想改密码：把新日期的 SHA-256 换到 PASS_HASH 即可。
 * （浏览器控制台或 PowerShell 都能算）
 */
(function () {
  var KEY = 'bowang-unlocked';
  var PASS_HASH = 'c707bfb00ad5d8076b8bdf273c431ccebd9517b081fe90d73150f0a2b6e2b1af';

  /**
   * 永久入口的钥匙。
   * 访问 /write/?k=这串 就直接进入，不依赖浏览器存储。
   * 手机浏览器/App 内置浏览器经常会清掉 localStorage，
   * 所以把带钥匙的地址存成书签最可靠——书签是浏览器自己保管的。
   */
  var PERMA_KEY = 'a7f3c2e9d1b6';

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

    /**
     * 是否可以进入。
     * 满足任意一条即可：
     *   ① 网址里带了正确的永久钥匙（最可靠，存成书签用）
     *   ② 这台设备的浏览器记住了（localStorage）
     */
    unlocked: function () {
      try {
        var m = String(location.search).match(/[?&]k=([A-Za-z0-9]+)/);
        if (m && m[1] === PERMA_KEY) {
          try {
            localStorage.setItem(KEY, '1');
          } catch (e) {}
          return true;
        }
      } catch (e) {}

      try {
        return localStorage.getItem(KEY) === '1';
      } catch (e) {
        return false;
      }
    },

    /** 给用户保存的永久入口地址 */
    permalink: function () {
      return location.origin + '/write/?k=' + PERMA_KEY;
    },

    mark: function () {
      try {
        localStorage.setItem(KEY, '1');
      } catch (e) {}
    },

    /** 手动退出：清掉本机的记录，下次要重填 */
    lock: function () {
      try {
        localStorage.removeItem(KEY);
      } catch (e) {}
    },
  };
})();
