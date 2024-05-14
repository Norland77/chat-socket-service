import { IFile } from './IFile';
import { IUser } from './IUser';

export interface IMessage {
  id: string;
  text: string;
  username: string;
  userId: string;
  roomId: string;
  createdAt: Date;
  updatedAt: Date;
  files?: IFile[];
  User?: IUser;
}
