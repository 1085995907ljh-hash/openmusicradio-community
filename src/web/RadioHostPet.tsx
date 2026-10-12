import { HOST_PROFILES, type HostProfileId } from "../shared/program-options";

const HOST_PET_ASSETS: Readonly<Record<HostProfileId, string>> = Object.freeze({
  anxuan: "/hosts/long-anxuan.png",
  anran: "/hosts/long-anran.png",
  anya: "/hosts/long-anya.png",
  longxin: "/hosts/long-xin.png",
  xiaocheng: "/hosts/long-xiaocheng.png",
  longhao: "/hosts/long-hao.png",
});

const HOST_PORTRAIT_ASSETS: Readonly<Record<HostProfileId, string>> = Object.freeze({
  anxuan: "/hosts/portraits/anxuan-illustration-v1.png",
  anran: "/hosts/portraits/anran-illustration-v1.png",
  anya: "/hosts/portraits/anya-illustration-v1.png",
  longxin: "/hosts/portraits/longxin-illustration-v1.png",
  xiaocheng: "/hosts/portraits/xiaocheng-illustration-v1.png",
  longhao: "/hosts/portraits/longhao-illustration-v1.png",
});

export function RadioHostAvatar({ profileId, portrait = false }: { profileId: HostProfileId; portrait?: boolean }) {
  const profile = HOST_PROFILES[profileId];
  return <img className={`host-avatar ${portrait ? "host-avatar-portrait" : ""}`} src={(portrait ? HOST_PORTRAIT_ASSETS : HOST_PET_ASSETS)[profileId]} alt="" aria-hidden="true" draggable={false} />;
}
