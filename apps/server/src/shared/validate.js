/**
 * Минималистичные guard-функции для валидации входа на границе API.
 * Без npm-зависимостей. Бросают UserError → роутер вернёт 400 с сообщением.
 */
import { UserError } from "./http.js";

export function requireString(value, field, { max = 500, allowEmpty = false } = {}) {
  if (typeof value !== "string") {
    throw new UserError(`Поле «${field}» должно быть строкой.`);
  }
  if (!allowEmpty && !value.trim()) {
    throw new UserError(`Поле «${field}» не должно быть пустым.`);
  }
  if (value.length > max) {
    throw new UserError(`Поле «${field}» слишком длинное (максимум ${max} символов).`);
  }
  return value;
}

export function optionalString(value, field, { max = 500 } = {}) {
  if (value === undefined || value === null) return value ?? null;
  return requireString(value, field, { max, allowEmpty: true });
}

export function requireArray(value, field, { max = 1000 } = {}) {
  if (!Array.isArray(value)) {
    throw new UserError(`Поле «${field}» должно быть массивом.`);
  }
  if (value.length > max) {
    throw new UserError(`Поле «${field}» слишком большое (максимум ${max} элементов).`);
  }
  return value;
}

export function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UserError(`Поле «${field}» должно быть объектом.`);
  }
  return value;
}

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Дата встречи: допускаем пустую/отсутствующую (домен подставит фолбэк),
 * но непустая обязана быть в формате YYYY-MM-DD.
 */
export function optionalIsoDate(value, field) {
  if (value === undefined || value === null || value === "") return value ?? null;
  if (typeof value !== "string" || !ISO_DATE_REGEX.test(value)) {
    throw new UserError(`Поле «${field}» должно быть датой в формате ГГГГ-ММ-ДД.`);
  }
  return value;
}

export const ID_REGEX = /^[a-zA-Z0-9_-]+$/;

export function requireId(value, message) {
  if (typeof value !== "string" || !ID_REGEX.test(value)) {
    throw new UserError(message);
  }
  return value;
}
