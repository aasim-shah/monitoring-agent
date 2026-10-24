import { assertFreeDisk } from '../disk-guard.js';

/** Smoke tests build every image; refuse early on a nearly full disk. */
export default function setup() {
  assertFreeDisk();
}
