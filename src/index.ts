import {WebSocketConstructor} from "./ws.js";
export * from "./ws.js";

export function websocketRequest<InitDataType>() {
    return new WebSocketConstructor<InitDataType>;
}