import { HttpRequest } from '@marblejs/core';
import { Observable } from 'rxjs';
import { takeUntil, tap, defaultIfEmpty, mapTo } from 'rxjs/operators';

type FieldEvent = [string, any, boolean, boolean, string, string];

export const parseField = (req: HttpRequest<any>) => (event$: Observable<FieldEvent>, finish$: Observable<any>) =>
  event$.pipe(
    takeUntil(finish$),
    tap(([ fieldname, value ]) => {
      req.body = {
        ...req.body ?? {},
        [fieldname]: value,
      };
    }),
    mapTo(req),
    defaultIfEmpty(req),
  );
