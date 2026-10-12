import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { AuthSessionService } from './auth-session.service';

export const bearerTokenInterceptor: HttpInterceptorFn = (request, next) => {
  const session = inject(AuthSessionService);
  const token = session.accessToken;
  const waitingRoomTicket = session.activeWaitingRoomTicket;
  if (request.url === '/api/v1/orders' && waitingRoomTicket) {
    request = request.clone({ setHeaders: { 'X-Waiting-Room-Ticket': waitingRoomTicket } });
  }
  const isCredentialRequest = request.url.startsWith('/api/v1/auth/')
    || request.url.startsWith('/api/v1/oauth/');
  if (!token || !request.url.startsWith('/api/') || isCredentialRequest
      || request.headers.has('Authorization')) {
    return next(request);
  }
  return next(request.clone({ setHeaders: { Authorization: `Bearer ${token}` } }));
};
