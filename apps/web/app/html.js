/**
 * Единая точка доступа к React + htm.
 * Библиотеки загружаются классическими <script> в index.html до модулей,
 * поэтому window.React / window.htm гарантированно доступны на момент импорта.
 */
export const React = window.React;
export const html = window.htm.bind(window.React.createElement);
export const { useState, useEffect, useRef } = window.React;
