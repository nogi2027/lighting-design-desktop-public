import type { DesktopState, ImportSource } from '../desktop/show-model';
import type { FormattedDocument } from './formatted-script';
type Session = { state: DesktopState; path:string|null; dirty:boolean };
declare global { interface Window {
 desktopShowId?: string; desktopForceOcr?: boolean; desktopFlush?: () => Promise<boolean>;
 desktop: { session():Promise<Session|null>; newShow():Promise<void>; examples():Promise<Array<{id:string;title:string;description:string}>>; example(id:string):Promise<ImportSource>; openPdf():Promise<ImportSource|null>; recent():Promise<Array<{identity:{id:string;title:string};updatedAt:string}>>; recovery():Promise<unknown[]>; recover(id:string):Promise<Session>; openShow(path?:string):Promise<Session|null>; save(as?:boolean):Promise<Session|null>; finishImport(state:DesktopState,reading:FormattedDocument):Promise<Session>; onCommand(callback:(name:string)=>void):()=>void };
} }
