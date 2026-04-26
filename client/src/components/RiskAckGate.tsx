import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { api } from "../lib/api";

/**
 * 风险免责声明弹窗。
 * 只有 my_profile.risk_warning_ack === 1 时不展示；否则强制弹窗，必须勾选确认才能继续使用。
 *
 * v0.3 强制：与多账号角色隔离（运营/辅助）一同上线。
 */
export default function RiskAckGate({ children }: { children: React.ReactNode }) {
  const [acked, setAcked] = useState<boolean | null>(null);
  const [agree, setAgree] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const p = await api.get("/api/profile");
        setAcked(Boolean(p?.risk_warning_ack));
      } catch {
        // 没有 profile 也算未确认
        setAcked(false);
      }
    })();
  }, []);

  if (acked === null) return null;     // 加载中
  if (acked) return <>{children}</>;   // 已确认，正常展示

  const handleAccept = async () => {
    if (!agree) return;
    setSubmitting(true);
    try {
      await api.patch("/api/profile", { risk_warning_ack: 1 });
      setAcked(true);
    } catch (e) {
      alert(`保存失败：${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4">
        <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl overflow-hidden">
          <div className="bg-rose-50 border-b border-rose-100 px-6 py-4 flex items-center gap-3">
            <ShieldAlert size={22} className="text-rose-500" />
            <div>
              <h2 className="text-lg font-semibold text-zinc-800">使用前必读：风险与免责声明</h2>
              <p className="text-xs text-zinc-500 mt-0.5">首次使用必须确认。仅展示一次。</p>
            </div>
          </div>

          <div className="p-6 max-h-[60vh] overflow-y-auto text-sm text-zinc-700 leading-relaxed space-y-4">
            <p className="font-medium text-rose-600">
              ⚠️ 本工具调用了第三方爬虫库（MediaCrawler）和 Playwright 浏览器自动化，存在以下不可消除的风险：
            </p>

            <section>
              <h3 className="font-semibold text-zinc-800 mb-1">1. 账号封禁风险（高）</h3>
              <ul className="list-disc pl-5 space-y-1">
                <li>小红书已开始大规模治理 RPA / 浏览器自动化操作，曾出现一周内 30+ 账号永封案例。</li>
                <li>所有需登录态的操作（搜索、抓取、发布）都是高风险动作，<b>无法保证账号绝对安全</b>。</li>
                <li>同一手机/同 IP 出现"频繁切号 + 自动化操作"会被关联封禁。</li>
              </ul>
            </section>

            <section>
              <h3 className="font-semibold text-zinc-800 mb-1">2. 强烈建议</h3>
              <ul className="list-disc pl-5 space-y-1">
                <li><b>不要把运营账号当成爬虫号</b>。运营账号用于发布与人设维护，高频搜索/抓取请改用辅助账号。</li>
                <li>建议把高风险操作分散到辅助账号，并控制频率（间隔至少 30 分钟）。</li>
                <li>不要短时间内频繁触发自动化（间隔至少 30 分钟）；建议手机+网络与主号物理隔离。</li>
                <li>如出现验证码、提示异常登录，立即停止操作并切换网络环境。</li>
              </ul>
            </section>

            <section>
              <h3 className="font-semibold text-zinc-800 mb-1">3. 免责声明</h3>
              <ul className="list-disc pl-5 space-y-1">
                <li>本工具仅限 <b>个人学习和创作辅助</b> 使用，禁止商业化、批量起号、薅羊毛等用途。</li>
                <li>因使用本工具产生的任何账号封禁、数据丢失、法律纠纷，<b>由使用者本人承担全部后果</b>。</li>
                <li>本工具不存储/上传/转售任何用户登录态或个人数据，所有数据保留在本机 <code>data/</code> 目录。</li>
                <li>使用即表示你已阅读并同意 MediaCrawler 与本项目的开源协议条款。</li>
              </ul>
            </section>

            <p className="text-xs text-zinc-500 pt-2 border-t border-zinc-100">
              如果你对上述风险无法接受，请关闭并删除本工具。
            </p>
          </div>

          <div className="px-6 py-4 bg-zinc-50 border-t border-zinc-100 flex items-center justify-between gap-4">
            <label className="flex items-center gap-2 text-sm text-zinc-700 cursor-pointer">
              <input
                type="checkbox"
                checked={agree}
                onChange={(e) => setAgree(e.target.checked)}
                className="w-4 h-4 accent-rose-500"
              />
              我已阅读并理解上述全部风险，自愿承担使用本工具产生的一切后果
            </label>
            <button
              onClick={handleAccept}
              disabled={!agree || submitting}
              className="px-5 py-2 rounded-lg bg-[#ff2442] text-white text-sm font-medium hover:bg-[#e51d39] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? "保存中…" : "我已知晓，开始使用"}
            </button>
          </div>
        </div>
      </div>
      {/* 同时渲染主内容（被遮罩遮挡），避免布局抖动 */}
      <div aria-hidden="true">{children}</div>
    </>
  );
}
