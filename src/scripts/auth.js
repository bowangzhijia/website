/**
 * 写作台门禁（浅浅保密）
 *
 * 说明：这是前端校验，作用是「防止访客顺手发现后台」，
 * 不是真正的安全措施——真正的门锁是 GitHub 令牌。
 * 代码里只存答案的 SHA-256 哈希，不存明文。
 *
 * 填对一次之后，本机会记住（localStorage 和 Cookie 各存一份），
 * 下次直接进，不用再填。换了设备或清了浏览数据才需要重填。
 * 想手动清掉：在写作台点右上角「退出设置」。
 *
 * 改密码：把新答案**转小写后**的 SHA-256 换到 PASS_HASH 即可。
 * 校验时会忽略大小写和首尾空格，所以 jason / Jason / JASON 都算对。
 *
 * 注意：这个文件由 BaseLayout 以 `?raw` 方式内联进每个页面的 HTML，
 * 不经过独立文件的 HTTP 缓存，所以改了立刻生效，不用管缓存。
 */
(function () {
  var KEY = 'bowang-unlocked';
  var PASS_HASH = '06b9a6eacd7a77b9361123fd19776455eb16b9c83426a1abbf514a414792b73f';

  /**
   * 救命绳：访问 /write/?k=这串 直接进入，完全不依赖浏览器存储。
   * 页面上没有任何入口，只有忘了密码时才会用到。
   */
  var PERMA_KEY = 'a7f3c2e9d1b6';

  /** Cookie 有效期 10 年，让「记住」这件事活得尽量久 */
  var COOKIE_MAX_AGE = 315360000;

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

  /**
   * 记住状态存两份：localStorage + Cookie。
   * App 内置浏览器、隐私模式、系统清理工具都可能清掉 localStorage，
   * 但 Cookie 常常还在；两份都写，被清掉时至少还有一份兜底。
   */
  function save() {
    try {
      localStorage.setItem(KEY, '1');
    } catch (e) {}
    try {
      document.cookie =
        KEY +
        '=1; max-age=' +
        COOKIE_MAX_AGE +
        '; path=/; SameSite=Lax' +
        (location.protocol === 'https:' ? '; Secure' : '');
    } catch (e) {}
  }

  function read() {
    try {
      if (localStorage.getItem(KEY) === '1') return true;
    } catch (e) {}
    try {
      return new RegExp('(?:^|;\\s*)' + KEY + '=1(?:;|$)').test(document.cookie);
    } catch (e) {
      return false;
    }
  }

  function clear() {
    try {
      localStorage.removeItem(KEY);
    } catch (e) {}
    try {
      document.cookie = KEY + '=; max-age=0; path=/';
    } catch (e) {}
  }

  window.BowangAuth = {
    /** 答案是否正确。忽略大小写与首尾空格 */
    check: function (value) {
      var v = String(value || '')
        .trim()
        .toLowerCase();
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
     * 是否可以进入。满足任意一条即可：
     *   ① 网址里带了正确的救命绳
     *   ② 这台设备记住过（localStorage 或 Cookie）
     */
    unlocked: function () {
      try {
        var m = String(location.search).match(/[?&]k=([A-Za-z0-9]+)/);
        if (m && m[1] === PERMA_KEY) {
          save();
          return true;
        }
      } catch (e) {}

      return read();
    },

    mark: save,

    /** 手动退出：清掉本机的记录，下次要重填 */
    lock: clear,
  };
})();
