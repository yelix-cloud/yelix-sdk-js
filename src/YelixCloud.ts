import type { OpenAPICore } from 'jsr:@yelix/openapi';
import { hostname, platform, networkInterfaces } from 'node:os';

// deno-lint-ignore require-await
async function getMachineIP(): Promise<string | null> {
  const interfaces = networkInterfaces();
  for (const ifaceList of Object.values(interfaces)) {
    if (!ifaceList) continue;
    for (const iface of ifaceList) {
      if (iface.family === 'IPv4' && !iface.address.startsWith('127.')) {
        return iface.address;
      }
    }
  }
  return null;
}

const machineName = hostname();
const machineIP = await getMachineIP();
const machinePlatform = platform();

type RequestData = {
  startTime: number;
  path: string;
  duration: number; // float
  method: string;
};

type QueuedRequest = {
  request: RequestData;
  resolve: (value: boolean) => void;
  reject: (error: Error) => void;
};

export class YelixCloud {
  private projectSourceId: string | 'Not-Initialized' | 'Initializing' =
    'Not-Initialized';
  private apiKey: string;
  private requestQueue: QueuedRequest[] = [];
  private isProcessingQueue = false;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('API key is required to initialize YelixCloud');
    }
    this.apiKey = apiKey;
  }
  private async initialize(environment: string, scheme: OpenAPICore) {
    if (this.projectSourceId !== 'Not-Initialized') {
      throw new Error('YelixCloud is already initialized');
    }
    this.projectSourceId = 'Initializing';

    this.projectSourceId = `${environment}-${scheme}`;

    try {
      const response = await fetch(
        'http://localhost:8000/api/v1/collect/project-source',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            environment,
            scheme,
          }),
        }
      );

      if (!response.ok) {
        throw new Error('Failed to collect project source');
      }

      const data = await response.json();
      this.projectSourceId = data.data.projectSourceId;

      // Process any queued requests
      this.processQueue();
    } catch (error) {
      console.error('Failed to initialize YelixCloud:', error);
      this.projectSourceId = 'Not-Initialized';
      throw error;
    }
  }
  private processQueue() {
    if (this.isProcessingQueue || this.requestQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.requestQueue.length > 0) {
      const queuedRequest = this.requestQueue.shift();
      if (!queuedRequest) continue;

      // Fire and forget - don't await
      this.sendRequest(queuedRequest.request)
        .then((result) => queuedRequest.resolve(result))
        .catch((error) =>
          queuedRequest.reject(
            error instanceof Error ? error : new Error(String(error))
          )
        );
    }

    this.isProcessingQueue = false;
  }

  private async sendRequest(request: RequestData): Promise<boolean> {
    try {
      const response = await fetch(
        'http://localhost:8000/api/v1/collect/request',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            startTime: request.startTime,
            path: request.path,
            duration: request.duration,
            method: request.method,
            metaData: {
              source: {
                projectSourceId: this.projectSourceId,
                machineName,
                machineIP,
                machineOS: machinePlatform,
              },
            },
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to log request: ${response.statusText}`);
      }

      return true;
    } catch (error) {
      console.error('Failed to send request:', error);
      throw error;
    }
  }

  logRequest(
    request: RequestData
  ):
    | Promise<boolean>
    | ((environment: string, scheme: OpenAPICore) => Promise<boolean>) {
    console.log(
      `Request logged: ${request.method} ${request.path} - Duration: ${request.duration} ms`
    );

    if (this.projectSourceId === 'Not-Initialized') {
      return async (environment: string, scheme: OpenAPICore) => {
        await this.initialize(environment, scheme);
        // After initialization, process this request
        return new Promise<boolean>((resolve, reject) => {
          this.requestQueue.push({ request, resolve, reject });
          this.processQueue();
        });
      };
    }

    if (this.projectSourceId === 'Initializing') {
      // Queue the request while initializing
      return new Promise<boolean>((resolve, reject) => {
        this.requestQueue.push({ request, resolve, reject });
      });
    }

    // Process immediately if initialized
    return this.sendRequest(request);
  }
}
