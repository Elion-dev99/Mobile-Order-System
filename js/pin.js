import { scopedKey, resolveShopId } from './tenant.js';

const PIN_AUTH_KEY = 'mos_table_pin_auth';

function pinStorageKey() {
  return scopedKey('mos_table_pins');
}

function safeParse(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

export const TablePin = {
  loadPins() {
    const scoped = safeParse(localStorage.getItem(pinStorageKey()));
    if (Object.keys(scoped).length) return scoped;
    // legacy global fallback
    return safeParse(localStorage.getItem('mos_table_pins'));
  },

  savePins(pins) {
    localStorage.setItem(pinStorageKey(), JSON.stringify(pins));
    return pins;
  },

  getPin(tableNumber) {
    const pins = this.loadPins();
    const encoded = pins[tableNumber];
    if (!encoded) return null;
    try {
      return atob(encoded);
    } catch {
      return null;
    }
  },

  setPin(tableNumber, pin) {
    const pins = this.loadPins();
    pins[tableNumber] = btoa(pin);
    this.savePins(pins);
  },

  clearPin(tableNumber) {
    const pins = this.loadPins();
    delete pins[tableNumber];
    this.savePins(pins);
  },

  isProtected(tableNumber) {
    return !!this.getPin(tableNumber);
  },

  validatePin(tableNumber, pin) {
    return this.getPin(tableNumber) === pin;
  },

  loadAuth() {
    return safeParse(sessionStorage.getItem(scopedKey(PIN_AUTH_KEY)));
  },

  saveAuth(auth) {
    sessionStorage.setItem(scopedKey(PIN_AUTH_KEY), JSON.stringify(auth));
    return auth;
  },

  isAuthenticated(tableNumber) {
    if (!this.isProtected(tableNumber)) return true;
    const auth = this.loadAuth();
    return auth[tableNumber] === true;
  },

  setAuthenticated(tableNumber) {
    const auth = this.loadAuth();
    auth[tableNumber] = true;
    this.saveAuth(auth);
  },

  clearAuthenticated(tableNumber) {
    const auth = this.loadAuth();
    delete auth[tableNumber];
    this.saveAuth(auth);
  },

  shopId() {
    return resolveShopId();
  },
};
