import axios from "axios";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API = `${BACKEND_URL}/api`;

export const api = axios.create({
  baseURL: API,
  withCredentials: true, // auth travels via the httpOnly access_token cookie — never localStorage
  headers: { "Content-Type": "application/json" },
});

export const fmtHKD = (v) =>
  new Intl.NumberFormat("en-HK", {
    style: "currency",
    currency: "HKD",
    minimumFractionDigits: 0,
  }).format(v || 0);
