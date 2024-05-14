import { IFile } from './IFile';

export interface IRoomCreate {
  file: IFile;
  userId: string;
  name: string;
  isPrivate: boolean;
}
