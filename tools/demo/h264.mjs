// A tiny H.264 writer for the change demo's drone videos: every frame is an IDR picture of I_PCM
// macroblocks (uncompressed 4:2:0 samples, constrained baseline, CAVLC), muxed into an MP4 with
// the moov box first. No encoder library, so the bytes are the same on every machine and the
// frames decode exactly (no compression noise between the two dates). The price is size: keep the
// clips small (a few hundred pixels across, a few frames a second).

const clamp = (v) => (v < 1 ? 1 : v > 254 ? 254 : v);

/**
 * BT.601 limited-range YUV 4:2:0 planes (Y, then Cb, then Cr) of an RGB image; `width` and
 * `height` even. Chroma is the mean of each 2 x 2 block.
 */
export function rgbToYuv420(rgb, width, height) {
  const cw = width / 2;
  const ch = height / 2;
  const out = Buffer.alloc(width * height + 2 * cw * ch);
  for (let i = 0; i < width * height; i++) {
    const r = rgb[3 * i];
    const g = rgb[3 * i + 1];
    const b = rgb[3 * i + 2];
    out[i] = clamp(Math.round(16 + (65.481 * r + 128.553 * g + 24.966 * b) / 255));
  }
  const u0 = width * height;
  const v0 = u0 + cw * ch;
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        const o = ((2 * y + dy) * width + 2 * x + dx) * 3;
        r += rgb[o];
        g += rgb[o + 1];
        b += rgb[o + 2];
      }
      r /= 4;
      g /= 4;
      b /= 4;
      out[u0 + y * cw + x] = clamp(Math.round(128 + (-37.797 * r - 74.203 * g + 112 * b) / 255));
      out[v0 + y * cw + x] = clamp(Math.round(128 + (112 * r - 93.786 * g - 18.214 * b) / 255));
    }
  return out;
}

/** Bit writer for RBSP (exp-Golomb codes, MSB first). */
class Rbsp {
  constructor(size) {
    this.buf = Buffer.alloc(size);
    this.pos = 0;
    this.acc = 0;
    this.n = 0;
  }

  bit(b) {
    this.acc = (this.acc << 1) | (b & 1);
    if (++this.n === 8) {
      this.buf[this.pos++] = this.acc;
      this.acc = 0;
      this.n = 0;
    }
  }

  u(v, bits) {
    for (let i = bits - 1; i >= 0; i--) this.bit((v >>> i) & 1);
  }

  ue(v) {
    const x = v + 1;
    const len = 32 - Math.clz32(x);
    this.u(0, len - 1);
    this.u(x, len);
  }

  se(v) {
    this.ue(v <= 0 ? -2 * v : 2 * v - 1);
  }

  align() {
    while (this.n !== 0) this.bit(0);
  }

  bytes(b) {
    if (this.n !== 0) throw new Error('rbsp: bytes need byte alignment');
    b.copy(this.buf, this.pos);
    this.pos += b.length;
  }

  trailing() {
    this.bit(1);
    this.align();
    return this.buf.subarray(0, this.pos);
  }
}

/** NAL unit with emulation prevention (no 00 00 0x, x <= 3, inside the payload). */
function nal(type, refIdc, rbsp) {
  const out = Buffer.alloc(rbsp.length + Math.ceil(rbsp.length / 2) + 1);
  let o = 0;
  out[o++] = (refIdc << 5) | type;
  let zeros = 0;
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 3) {
      out[o++] = 3;
      zeros = 0;
    }
    out[o++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, o);
}

/**
 * Encode RGB frames (`width` x `height`, both even) as I_PCM IDR pictures. Returns the parameter
 * sets and one length-prefixed (AVCC) sample per frame, for muxMp4.
 */
export function encodeH264Pcm(frames, width, height) {
  if (width % 2 || height % 2) throw new Error('h264: width and height must be even');
  const mbw = Math.ceil(width / 16);
  const mbh = Math.ceil(height / 16);
  const cw = mbw * 16;
  const chh = mbh * 16;

  const s = new Rbsp(64);
  s.u(66, 8); // profile_idc: baseline
  s.u(0xc0, 8); // constraint_set0 and set1: constrained baseline
  s.u(30, 8); // level 3.0
  s.ue(0); // seq_parameter_set_id
  s.ue(0); // log2_max_frame_num_minus4
  s.ue(2); // pic_order_cnt_type
  s.ue(1); // max_num_ref_frames
  s.u(0, 1); // gaps_in_frame_num_value_allowed_flag
  s.ue(mbw - 1);
  s.ue(mbh - 1);
  s.u(1, 1); // frame_mbs_only_flag
  s.u(1, 1); // direct_8x8_inference_flag
  const crop = cw !== width || chh !== height;
  s.u(crop ? 1 : 0, 1);
  if (crop) {
    s.ue(0);
    s.ue((cw - width) / 2);
    s.ue(0);
    s.ue((chh - height) / 2);
  }
  s.u(0, 1); // vui_parameters_present_flag
  const sps = nal(7, 3, s.trailing());

  const p = new Rbsp(16);
  p.ue(0); // pic_parameter_set_id
  p.ue(0); // seq_parameter_set_id
  p.u(0, 1); // entropy_coding_mode_flag: CAVLC
  p.u(0, 1); // bottom_field_pic_order_in_frame_present_flag
  p.ue(0); // num_slice_groups_minus1
  p.ue(0); // num_ref_idx_l0_default_active_minus1
  p.ue(0); // num_ref_idx_l1_default_active_minus1
  p.u(0, 1); // weighted_pred_flag
  p.u(0, 2); // weighted_bipred_idc
  p.se(0); // pic_init_qp_minus26
  p.se(0); // pic_init_qs_minus26
  p.se(0); // chroma_qp_index_offset
  p.u(1, 1); // deblocking_filter_control_present_flag
  p.u(0, 1); // constrained_intra_pred_flag
  p.u(0, 1); // redundant_pic_cnt_present_flag
  const pps = nal(8, 3, p.trailing());

  const samples = frames.map((rgb, f) => {
    // planes at the coded size, edges repeated
    const yuv = rgbToYuv420(rgb, width, height);
    const Y = Buffer.alloc(cw * chh);
    const U = Buffer.alloc((cw / 2) * (chh / 2));
    const V = Buffer.alloc((cw / 2) * (chh / 2));
    for (let y = 0; y < chh; y++)
      for (let x = 0; x < cw; x++)
        Y[y * cw + x] = yuv[Math.min(height - 1, y) * width + Math.min(width - 1, x)];
    const u0 = width * height;
    const v0 = u0 + (width / 2) * (height / 2);
    for (let y = 0; y < chh / 2; y++)
      for (let x = 0; x < cw / 2; x++) {
        const k = Math.min(height / 2 - 1, y) * (width / 2) + Math.min(width / 2 - 1, x);
        U[y * (cw / 2) + x] = yuv[u0 + k];
        V[y * (cw / 2) + x] = yuv[v0 + k];
      }
    const r = new Rbsp(64 + mbw * mbh * (384 + 4));
    r.ue(0); // first_mb_in_slice
    r.ue(7); // slice_type: I (all slices)
    r.ue(0); // pic_parameter_set_id
    r.u(0, 4); // frame_num
    r.ue(f % 2); // idr_pic_id: differs between consecutive IDR pictures
    r.u(0, 1); // no_output_of_prior_pics_flag
    r.u(0, 1); // long_term_reference_flag
    r.se(0); // slice_qp_delta
    r.ue(1); // disable_deblocking_filter_idc: off
    const mb = Buffer.alloc(384);
    for (let my = 0; my < mbh; my++)
      for (let mx = 0; mx < mbw; mx++) {
        r.ue(25); // mb_type: I_PCM
        r.align(); // pcm_alignment_zero_bit
        for (let y = 0; y < 16; y++)
          Y.copy(mb, y * 16, (my * 16 + y) * cw + mx * 16, (my * 16 + y) * cw + mx * 16 + 16);
        for (let y = 0; y < 8; y++) {
          U.copy(
            mb,
            256 + y * 8,
            (my * 8 + y) * (cw / 2) + mx * 8,
            (my * 8 + y) * (cw / 2) + mx * 8 + 8,
          );
          V.copy(
            mb,
            320 + y * 8,
            (my * 8 + y) * (cw / 2) + mx * 8,
            (my * 8 + y) * (cw / 2) + mx * 8 + 8,
          );
        }
        r.bytes(mb);
      }
    const unit = nal(5, 3, r.trailing());
    const len = Buffer.alloc(4);
    len.writeUInt32BE(unit.length, 0);
    return Buffer.concat([len, unit]);
  });
  return { sps, pps, samples, width, height };
}

// ------------------------------------------------------------------ MP4 (ISO BMFF)

const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0, 0);
  return b;
};
const u16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v, 0);
  return b;
};
const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
};
const full = (type, version, flags, ...parts) =>
  box(
    type,
    Buffer.from([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]),
    ...parts,
  );
const MATRIX = Buffer.concat(
  [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map((v) => u32(v)),
);

/**
 * An MP4 of the encoded clip at `fps` (a divisor of 90000), moov first, no dates, no names, no
 * location: creation and modification times are zero, the handler is plain "VideoHandler".
 */
export function muxMp4({ sps, pps, samples, width, height }, { fps }) {
  const TS = 90000;
  if (TS % fps) throw new Error(`mp4: fps ${fps} must divide ${TS}`);
  const delta = TS / fps;
  const n = samples.length;
  const durMs = Math.round((n * 1000) / fps);
  const ftyp = box(
    'ftyp',
    Buffer.from('isom', 'latin1'),
    u32(512),
    Buffer.from('isomiso2avc1mp41', 'latin1'),
  );
  const avcC = box(
    'avcC',
    Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]),
    u16(sps.length),
    sps,
    Buffer.from([1]),
    u16(pps.length),
    pps,
  );
  const avc1 = box(
    'avc1',
    Buffer.alloc(6),
    u16(1), // data_reference_index
    Buffer.alloc(16),
    u16(width),
    u16(height),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1), // frame_count
    Buffer.alloc(32), // compressorname: none
    u16(0x18),
    u16(0xffff),
    avcC,
  );
  const stbl = (chunkOffset) =>
    box(
      'stbl',
      full('stsd', 0, 0, u32(1), avc1),
      full('stts', 0, 0, u32(1), u32(n), u32(delta)),
      full('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1)),
      full('stsz', 0, 0, u32(0), u32(n), ...samples.map((x) => u32(x.length))),
      full('stco', 0, 0, u32(1), u32(chunkOffset)),
    );
  const moov = (chunkOffset) =>
    box(
      'moov',
      full(
        'mvhd',
        0,
        0,
        u32(0),
        u32(0),
        u32(1000),
        u32(durMs),
        u32(0x00010000),
        u16(0x0100),
        Buffer.alloc(10),
        MATRIX,
        Buffer.alloc(24),
        u32(2),
      ),
      box(
        'trak',
        full(
          'tkhd',
          0,
          3,
          u32(0),
          u32(0),
          u32(1),
          u32(0),
          u32(durMs),
          Buffer.alloc(8),
          u16(0),
          u16(0),
          u16(0),
          u16(0),
          MATRIX,
          u32(width << 16),
          u32(height << 16),
        ),
        box(
          'mdia',
          full('mdhd', 0, 0, u32(0), u32(0), u32(TS), u32(n * delta), u16(0x55c4), u16(0)),
          full(
            'hdlr',
            0,
            0,
            u32(0),
            Buffer.from('vide', 'latin1'),
            Buffer.alloc(12),
            Buffer.from('VideoHandler\0', 'latin1'),
          ),
          box(
            'minf',
            full('vmhd', 0, 1, Buffer.alloc(8)),
            box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
            stbl(chunkOffset),
          ),
        ),
      ),
    );
  const size = ftyp.length + moov(0).length + 8;
  const mdat = box('mdat', ...samples);
  return Buffer.concat([ftyp, moov(size), mdat]);
}
