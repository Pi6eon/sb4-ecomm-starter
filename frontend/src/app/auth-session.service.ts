import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class AuthSessionService {
  private token: string | null = null;
  private refresh: string | null = null;
  private waitingRoomTicket: string | null = null;

  get accessToken(): string | null {
    return this.token;
  }

  setAccessToken(token: string): void {
    this.token = token;
    this.refresh = null;
  }

  setCustomerSession(token: string, refreshToken: string): void {
    this.token = token;
    this.refresh = refreshToken;
  }

  get refreshToken(): string | null {
    return this.refresh;
  }

  setWaitingRoomTicket(ticket: string | null): void {
    this.waitingRoomTicket = ticket;
  }

  get activeWaitingRoomTicket(): string | null {
    return this.waitingRoomTicket;
  }

  clear(): void {
    this.token = null;
    this.refresh = null;
    this.waitingRoomTicket = null;
  }
}
