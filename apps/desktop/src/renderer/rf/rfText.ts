/**
 * The words for the RF store's codes (T8 returns codes; the tab owns the words). Every refusal,
 * exclusion, default warning, save and reassign code has an `en.ts` key here, so a new code fails
 * the type check until it has one.
 */
import type { PropagationModel, RfEnvironment, MarginPreset } from '@aio/schema';
import { RF_COVERAGE_MIN_PACK } from '@aio/schema';
import type { MessageKey, Vars } from '@aio/ui';
import type { DefaultWarning, DefaultWarningCode } from './rfDefaults';
import type { ExclusionCode, HeightBasis, RefusalCode } from './rfModel';
import type { ReassignResult, RfView } from './rfStore';

type T = (key: MessageKey, vars?: Vars) => string;

export const REFUSAL_KEY: Readonly<Record<RefusalCode, MessageKey>> = {
  'read-only': 'rf.refusal.readOnly',
  running: 'rf.refusal.running',
  'pack-missing': 'rf.refusal.packMissing',
  'pack-too-old': 'rf.refusal.packTooOld',
  'pack-unknown': 'rf.refusal.packUnknown',
  'no-antennas': 'rf.refusal.noAntennas',
  'no-sectors': 'rf.refusal.noSectors',
  'no-crs': 'rf.refusal.noCrs',
  'no-accepted-panels': 'rf.refusal.noAcceptedPanels',
  'no-band': 'rf.refusal.noBand',
  'no-height': 'rf.refusal.noHeight',
  'no-equipment': 'rf.refusal.noEquipment',
};

export function refusalText(t: T, code: RefusalCode): string {
  return t(REFUSAL_KEY[code], { min: RF_COVERAGE_MIN_PACK });
}

export const EXCLUSION_KEY: Readonly<Record<ExclusionCode, MessageKey>> = {
  rejected: 'rf.excluded.rejected',
  'not-found': 'rf.excluded.notFound',
  inactive: 'rf.excluded.inactive',
  dish: 'rf.excluded.dish',
  other: 'rf.excluded.other',
  'no-azimuth': 'rf.excluded.noAzimuth',
  'no-crs': 'rf.excluded.noCrs',
  short: 'rf.excluded.short',
  draft: 'rf.excluded.draft',
  removed: 'rf.excluded.removed',
  'not-in-sector': 'rf.excluded.notInSector',
  'no-settings': 'rf.excluded.noSettings',
  'no-equipment': 'rf.excluded.noEquipment',
  'no-equipment-entry': 'rf.excluded.noEquipmentEntry',
  'no-carrier': 'rf.excluded.noCarrier',
  'no-height': 'rf.excluded.noHeight',
  'not-above-ground': 'rf.excluded.notAboveGround',
};

export const WARNING_KEY: Readonly<Record<DefaultWarningCode, MessageKey>> = {
  'band-unknown': 'rf.default.bandUnknown',
  'scs-defaulted': 'rf.default.scs',
  'bandwidth-invalid': 'rf.default.bandwidthInvalid',
  'no-ports': 'rf.default.noPorts',
  'port-missing': 'rf.default.portMissing',
  'port-defaulted': 'rf.default.port',
  'etilt-defaulted': 'rf.default.etilt',
  'power-aau-total': 'rf.default.powerAau',
  'power-radio-max': 'rf.default.powerRadio',
  'power-missing': 'rf.default.powerMissing',
};

export function warningText(t: T, w: DefaultWarning): string {
  return t(WARNING_KEY[w.code], { detail: w.detail ?? '' });
}

export const REASSIGN_KEY: Readonly<Record<Exclude<ReassignResult, null>, MessageKey>> = {
  'read-only': 'rf.orphans.reassignReadOnly',
  'target-has-settings': 'rf.orphans.reassignTaken',
  failed: 'rf.orphans.reassignFailed',
};

export const HEIGHT_BASIS_KEY: Readonly<Record<HeightBasis, MessageKey>> = {
  measured: 'rf.basis.measured',
  estimated: 'rf.basis.estimated',
  user: 'rf.basis.user',
};

/** The basis of a detected value (`aio.antennas/1` ValueBasis). */
export const VALUE_BASIS_KEY: Readonly<Record<string, MessageKey>> = {
  measured: 'rf.basis.measured',
  observed: 'rf.basis.observed',
  inferred: 'rf.basis.inferred',
  user: 'rf.basis.user',
};

export const MODEL_KEY: Readonly<Record<PropagationModel, MessageKey>> = {
  tr38901: 'rf.study.model.tr38901',
  'okumura-hata': 'rf.study.model.okumuraHata',
  'cost231-hata': 'rf.study.model.cost231Hata',
  'free-space': 'rf.study.model.freeSpace',
};

export const ENVIRONMENT_KEY: Readonly<Record<RfEnvironment, MessageKey>> = {
  uma: 'rf.study.env.uma',
  umi: 'rf.study.env.umi',
  rma: 'rf.study.env.rma',
};

export const MARGIN_KEY: Readonly<Record<MarginPreset, MessageKey>> = {
  outdoor: 'rf.study.margin.outdoor',
  'in-car': 'rf.study.margin.inCar',
  indoor: 'rf.study.margin.indoor',
  'deep-indoor': 'rf.study.margin.deepIndoor',
};

export const VIEW_KEY: Readonly<Record<RfView, MessageKey>> = {
  rsrp: 'rf.results.view.rsrp',
  bestServer: 'rf.results.view.bestServer',
  overlap: 'rf.results.view.overlap',
};
