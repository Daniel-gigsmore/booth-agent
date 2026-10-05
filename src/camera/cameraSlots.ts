import { CameraSource } from "./CameraSource";
import { BoothConfig } from "../config/schema";
import { CameraSlot } from "../events/types";

export interface CameraFactories {
  /**
   * A Canon EDSDK worker for `slot`. `alone` means it is the only Canon in the
   * booth (the other slot is the Nikon), so it takes whichever Canon body is
   * plugged in instead of following the two-Canon pairing in cameras.json.
   */
  edsdk(slot: CameraSlot, alone: boolean): CameraSource;
  digiCamControl(): CameraSource;
  /** The Nikon for `slot`; the slot also names its saved settings file. */
  nikon(slot: CameraSlot): CameraSource;
}

/**
 * Which source fills the high and low camera positions.
 *
 * Without a Nikon nothing changes: EDSDK gives two Canon slots, digiCamControl
 * only a high one. With the Nikon enabled it takes its configured slot and the
 * Canon (either driver) takes the other.
 */
export function buildCameraSlots(capture: BoothConfig["capture"], make: CameraFactories): { high: CameraSource; low?: CameraSource } {
  const edsdk = capture.canon.driver === "edsdk";
  if (!capture.nikon.enabled) {
    return edsdk ? { high: make.edsdk("high", false), low: make.edsdk("low", false) } : { high: make.digiCamControl() };
  }
  const canonSlot: CameraSlot = capture.nikon.slot === "high" ? "low" : "high";
  const canon = edsdk ? make.edsdk(canonSlot, true) : make.digiCamControl();
  const nikonSlot = capture.nikon.slot;
  return nikonSlot === "high" ? { high: make.nikon("high"), low: canon } : { high: canon, low: make.nikon("low") };
}
