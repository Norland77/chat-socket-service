import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';

import { Namespace, Server, Socket } from 'socket.io';
import { S3 } from 'aws-sdk';
import { ConfigService } from '@nestjs/config';
import { DefaultEventsMap } from 'socket.io/dist/typed-events';
import { IAvatarEdit } from './interfaces/IAvatarEdit';
import { v4 } from 'uuid';
import { IRoomCreate } from './interfaces/IRoomCreate';
import { IMessage } from './interfaces/IMessage';
import { IFile } from './interfaces/IFile';
import { MessageDeleteDto } from './dto/message-delete.dto';
import {
  ClientProxy,
  ClientProxyFactory,
  Transport,
} from '@nestjs/microservices';
import { firstValueFrom, Observable } from 'rxjs';
import { IUser } from './interfaces/IUser';

let fullChunk: Buffer = Buffer.alloc(0);
let fullChunkArr: Buffer[] = [];

@WebSocketGateway(80, { cors: { origin: '*' } })
export class AppService implements OnGatewayInit {
  private readonly user_client: ClientProxy;
  private readonly room_client: ClientProxy;
  private readonly messages_client: ClientProxy;
  constructor(private readonly configService: ConfigService) {
    this.user_client = ClientProxyFactory.create({
      transport: Transport.TCP,
      options: {
        host: '127.0.0.1',
        port: 5001,
      },
    });
    this.room_client = ClientProxyFactory.create({
      transport: Transport.TCP,
      options: {
        host: '127.0.0.1',
        port: 5003,
      },
    });
    this.messages_client = ClientProxyFactory.create({
      transport: Transport.TCP,
      options: {
        host: '127.0.0.1',
        port: 5004,
      },
    });
  }

  @WebSocketServer() wss: Server;

  afterInit(server: any): any {
    console.log('init: ' + server);
  }

  handleConnection() {
    console.log('Connected');
  }

  async uploadPublicFile(
    dataBuffer: Buffer,
    filename: string,
    userId: string,
    filetype,
  ): Promise<S3.ManagedUpload.SendData> {
    const s3 = new S3();

    return s3
      .upload({
        Bucket: this.configService.get('AWS_PUBLIC_BUCKET_NAME'),
        Body: dataBuffer,
        Key: `${userId}/${filetype}/${filename}${v4()}`,
      })
      .promise();
  }
  @SubscribeMessage('chatToServer')
  async handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() message: IMessage,
  ) {
    const results: IFile[] = [];
    if (message.files.length > 0) {
      let index = 0;
      console.log(fullChunkArr);
      for (const fileInfo of message.files) {
        console.log(fullChunkArr[index]);
        const uploadResult: S3.ManagedUpload.SendData =
          await this.uploadPublicFile(
            fullChunkArr[index],
            fileInfo.name,
            message.userId,
            fileInfo.mimetype,
          );
        results.push({
          path: uploadResult.Location,
          name: fileInfo.name,
          mimetype: fileInfo.mimetype,
        });
        index++;
      }
    }
    console.log(results);
    const createdMessage: Observable<IMessage> = this.messages_client.send(
      'post.create',
      {
        text: message.text,
        username: message.username,
        roomId: message.roomId,
        userId: message.userId,
        files: results,
      },
    );
    const currentCreatedMessage = await firstValueFrom(createdMessage);
    fullChunkArr = [];
    this.wss.to(message.roomId).emit('chatToClient', currentCreatedMessage);
  }

  @SubscribeMessage('chatToServerSetAvatar')
  async handleSetAvatar(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: IAvatarEdit,
  ) {
    if (data.file) {
      const uploadResult: S3.ManagedUpload.SendData =
        await this.uploadPublicFile(
          fullChunk,
          data.file.name,
          data.userId,
          data.file.mimetype,
        );
      const observableUser: Observable<IUser> = this.user_client.send(
        'get.user.byId',
        data.userId,
      );
      const user = await firstValueFrom(observableUser);

      if (user.avatar_url !== null) {
        const s3: S3 = new S3();
        const observableAvatar: Observable<any> = this.messages_client.send(
          'get.fileByPath',
          user.avatar_url,
        );
        const avatar = await firstValueFrom(observableAvatar);

        await s3
          .deleteObject({
            Bucket: this.configService.get('AWS_PUBLIC_BUCKET_NAME'),
            Key: `${data.userId}/${avatar.mimetype}/${avatar.name}`,
          })
          .promise();

        this.messages_client.send('delete.fileById', avatar.id);
      }
      this.messages_client.send('post.uploadAvatar', {
        mimetype: data.file.mimetype,
        path: uploadResult.Location,
        name: data.file.name,
      });
      this.user_client.send('get.users.setAvatarById', {
        id: data.userId,
        avatar_url: uploadResult.Location,
      });
    }
    fullChunk = Buffer.alloc(0);
  }

  @SubscribeMessage('chatToServerCreateChat')
  async handleCreateChat(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: IRoomCreate,
  ) {
    if (data.file) {
      const uploadResult: S3.ManagedUpload.SendData =
        await this.uploadPublicFile(
          fullChunk,
          data.file.name,
          data.userId,
          data.file.mimetype,
        );

      this.messages_client.send('post.uploadAvatar', {
        mimetype: data.file.mimetype,
        path: uploadResult.Location,
        name: data.file.name,
      });
      this.room_client.send('post.create', {
        name: data.name,
        ownerId: data.userId,
        avatar_url: uploadResult.Location,
        isPrivate: data.isPrivate,
      });
    } else {
      this.room_client.send('post.create', {
        name: data.name,
        ownerId: data.userId,
        isPrivate: data.isPrivate,
      });
    }
    fullChunk = Buffer.alloc(0);
  }

  @SubscribeMessage('chatToServerDelete')
  async handleDeleteMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: MessageDeleteDto,
  ) {
    const s3: S3 = new S3();
    /*const deleteMessage: IMessage = await this.messageService.deleteMessage(
      dto.id,
    );*/

    const observableMessage: Observable<IMessage> = this.messages_client.send(
      'delete.byId',
      dto.id,
    );

    const deleteMessage = await firstValueFrom(observableMessage);

    if (deleteMessage) {
      deleteMessage.files.map(async (file: IFile): Promise<void> => {
        await s3
          .deleteObject({
            Bucket: this.configService.get('AWS_PUBLIC_BUCKET_NAME'),
            Key: `${deleteMessage.userId}/${file.mimetype}/${file.name}`,
          })
          .promise();
      });
    }
    this.wss.to(dto.roomId).emit('chatToClientDelete', dto.id);
  }

  @SubscribeMessage('chatToServerUpdate')
  async handleUpdateMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    message: {
      id: string;
      message: { text: string; roomId: string };
    },
  ): Promise<void> {
    this.messages_client.send('put.edit', message);
    this.wss.to(message.message.roomId).emit('chatToClientUpdate', message);
  }

  @SubscribeMessage('getUsersInRoom')
  handleUsersInRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() roomId: { roomId: string },
  ): void {
    const namespace: Namespace<DefaultEventsMap, any> = this.wss.of('/');
    const rooms: Map<string, Set<string>> = namespace.adapter.rooms;
    const room: Set<string> = rooms.get(roomId.roomId);
    if (room) {
      const userCount: number = room.size;
      this.wss.to(roomId.roomId).emit('UsersInRoom', userCount);
    } else {
      this.wss.to(roomId.roomId).emit('UsersInRoom', 0);
    }
  }

  @SubscribeMessage('joinRoom')
  handleRoomJoin(client: Socket, room: string): void {
    client.join(room);
    client.emit('joinedRoom', room);
  }

  @SubscribeMessage('leaveRoom')
  handleRoomLeft(client: Socket, room: string): void {
    client.leave(room);
    client.emit('leftRoom', room);
  }

  @SubscribeMessage('kickUser')
  handleRoomKick(
    client: Socket,
    @MessageBody() roomId: { roomId: string },
  ): void {
    this.wss.to(roomId.roomId).emit('kickedUser');
  }

  @SubscribeMessage('userAddToChat')
  handleRoomAddUserToChat(
    client: Socket,
    @MessageBody() roomId: { roomId: string },
  ): void {
    this.wss.to(roomId.roomId).emit('userAdd');
  }

  @SubscribeMessage('uploadChunk')
  async handleUploadChunk(@MessageBody() data: any): Promise<void> {
    fullChunk = Buffer.concat([fullChunk, data[0]]);
    if (data[1] === true) {
      fullChunkArr.push(fullChunk);
      fullChunk = Buffer.alloc(0);
    }
  }
}
