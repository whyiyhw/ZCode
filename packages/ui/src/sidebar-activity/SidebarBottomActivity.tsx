import { GlobalNoticeSurface } from "@/global-notice/GlobalNoticeSurface.js";
import type { GlobalNoticeStore } from "@/global-notice/globalNoticeStore.js";

/**
 * 左下角活动槽位的宿主：营销触达 banner 已随社区版裁剪（上报点击/关闭事件属采集面），
 * 槽位当前只承载全局通知（highspeed 分享卡）。
 *
 * 纯只读投影，不持有任何状态；GlobalNoticeSurface 不可见时返回 null，槽位不产生多余 DOM。
 */
export function SidebarBottomActivity({
  noticeStore,
}: {
  noticeStore?: GlobalNoticeStore | null;
} = {}) {
  // 未注入时走 GlobalNoticeSurface 默认的 browserGlobalNoticeStore。
  return <GlobalNoticeSurface store={noticeStore ?? undefined} />;
}
