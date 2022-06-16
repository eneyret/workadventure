import { ITiledMap, ITiledMapLayer, ITiledMapObject } from "@workadventure/tiled-map-type-guard/dist";
import Axios, { AxiosError, AxiosInstance } from "axios";
import { EJABBERD_DOMAIN, EJABBERD_PASSWORD, EJABBERD_URI, EJABBERD_USER } from "../Enum/EnvironmentVariable";
import { MapDetailsData } from "../Messages/JsonMessages/MapDetailsData";

interface Chat {
    chatName?: string;
    mucUrl?: string;
    mucCreated?: boolean;
    type?: string;
}

export class MucManager {
    /**
     * The list of chats for the current room
     */
    private chat: Map<string, Chat> | undefined;

    private axios: AxiosInstance | undefined;

    /**
     * @param roomUrl
     * @param map The map can be "null" if it is hosted on a private network. In this case, we assume this is a test setup and bypass any server-side checks.
     */
    constructor(private roomUrl: string, private map: ITiledMap | null, private mapDetails: MapDetailsData) {
        const auth = Buffer.from(EJABBERD_USER + "@" + EJABBERD_DOMAIN + ":" + EJABBERD_PASSWORD).toString("base64");
        this.axios = Axios.create({
            baseURL: "http://" + EJABBERD_URI + "/api/",
            headers: {
                Authorization: "Basic " + auth,
                timeout: 10000,
            },
        });

        this.chat = new Map<string, Chat>();

        // We initialize the list of variable object at room start. The objects cannot be edited later
        // (otherwise, this would cause a security issue if the scripting API can edit this list of objects)
        if (map) {
            this.chat = MucManager.findChatInMap(map);
            this.chat.forEach((chatZone) => {
                chatZone.mucUrl = `${this.roomUrl}/${chatZone.chatName}`;
                chatZone.mucCreated = false;
            });
            if (mapDetails.mucRooms) {
                // If the ADMIN exist we disable all the forums from the MAP
                this.chat.forEach((chat) => {
                    if (chat.type === "forum") {
                        chat.mucCreated = true;
                    }
                });
            } else {
                // If the ADMIN_URL is not set, so there is no admin, and we define a default chatForum MUC room if it's not defined in the map
                if (this.getDefaultForum() === null) {
                    this.chat.set("welcome", {
                        chatName: "welcome",
                        mucUrl: `${this.roomUrl}/welcome`,
                        mucCreated: false,
                        type: "forum",
                    } as Chat);
                }
            }
        }
    }

    public getDefaultForum(): Chat | null {
        let defaultForum = null;
        this.chat?.forEach((chat) => {
            if (chat.type === "forum") {
                defaultForum = chat;
            }
        });
        return defaultForum;
    }

    public async init() {
        const allMucRooms = await this.getAllMucRooms();
        const allMucRoomsOfWorld: string[] = [];
        if (Axios.isAxiosError(allMucRooms)) {
            console.warn("Error to get allMucRooms (AxiosError) : ", allMucRooms.response);
        } else if (allMucRooms instanceof Error) {
            console.warn("Error to get allMucRooms : ", allMucRooms);
        } else {
            allMucRooms.forEach((mucRoom) => {
                const [local] = mucRoom.split("@");
                const decoded = MucManager.decode(local);
                if (decoded?.includes(this.roomUrl)) {
                    allMucRoomsOfWorld.push(decoded);
                }
            });
            allMucRoomsOfWorld.forEach((mucRoom) => {
                let found = false;
                this.chat?.forEach((chatZone) => {
                    if (found) return;
                    if (chatZone.mucUrl) {
                        if (mucRoom.toLocaleLowerCase() === chatZone.mucUrl.toLocaleLowerCase()) {
                            found = true;
                            chatZone.mucCreated = true;
                        }
                    }
                });
                if (!found) {
                    this.destroyMucRoom(mucRoom);
                }
            });
            if (allMucRooms) {
                allMucRooms.forEach((mucRoom) => {
                    const [local] = mucRoom.split("@");
                    const decoded = MucManager.decode(local);
                    if (decoded?.includes(this.roomUrl)) {
                        allMucRoomsOfWorld.push(decoded);
                    }
                });
            }
            if (allMucRoomsOfWorld) {
                for (const mucRoom of allMucRoomsOfWorld) {
                    let found = false;
                    this.chat?.forEach((chatZone) => {
                        if (found) return;
                        if (chatZone.mucUrl) {
                            if (mucRoom.toLocaleLowerCase() === chatZone.mucUrl.toLocaleLowerCase()) {
                                found = true;
                                chatZone.mucCreated = true;
                            }
                        }
                    });
                    if (!found) {
                        await this.destroyMucRoom(mucRoom);
                    }
                }
            }
            if (this.chat) {
                for (const [, chatZone] of this.chat) {
                    if (chatZone.mucCreated) return;
                    if (chatZone.mucUrl) {
                        await this.createMucRoom(chatZone);
                        chatZone.mucCreated = true;
                    }
                }
            }
        }
    }

    private static findChatInMap(map: ITiledMap): Map<string, Chat> {
        const objects = new Map<string, Chat>();
        for (const layer of map.layers) {
            this.recursiveFindChatInLayer(layer, objects);
        }
        return objects;
    }

    private static recursiveFindChatInLayer(layer: ITiledMapLayer, objects: Map<string, Chat>): void {
        if (layer.type === "objectgroup") {
            for (const object of layer.objects) {
                if (object.type === "area") {
                    if (object.template) {
                        console.warn(
                            'Warning, a variable object is using a Tiled "template". WorkAdventure does not support objects generated from Tiled templates.'
                        );
                        continue;
                    }

                    // We store a copy of the object (to make it immutable)
                    const chatZone = this.iTiledObjectToChat(object);
                    objects.set(chatZone.chatName as string, chatZone);
                }
            }
        } else if (layer.type === "group") {
            for (const innerLayer of layer.layers as ITiledMapLayer[]) {
                this.recursiveFindChatInLayer(innerLayer, objects);
            }
        }
    }

    private static iTiledObjectToChat(object: ITiledMapObject): Chat {
        const variable: Chat = {};

        if (object.properties) {
            for (const property of object.properties) {
                const value = property.value as unknown;
                switch (property.name) {
                    case "chatName":
                        if (typeof value !== "string") {
                            throw new Error('The persist property of variable "' + object.name + '" must be a string');
                        }
                        variable.chatName = value;
                        variable.type = "live";
                        break;
                    case "chatForumName":
                        if (typeof value !== "string") {
                            throw new Error('The persist property of variable "' + object.name + '" must be a string');
                        }
                        variable.chatName = value;
                        variable.type = "forum";
                }
            }
        }

        return variable;
    }

    private async getAllMucRooms(): Promise<Array<string> | Error> {
        return (await this.axios
            ?.post("muc_online_rooms", { service: `conference.ejabberd` })
            .then((response) => response.data as Array<string>)
            .catch((error) => error as AxiosError)) as unknown as Promise<Array<string> | Error>;
    }

    private async destroyMucRoom(name: string) {
        await this.axios
            ?.post("destroy_room", { name: MucManager.encode(name), service: `conference.ejabberd` })
            .catch((error) => console.error(error));
    }

    private async createMucRoom(chatZone: Chat) {
        await this.axios
            ?.post("create_room", {
                name: `${MucManager.encode(chatZone.mucUrl ?? "")}`,
                host: EJABBERD_DOMAIN,
                service: `conference.ejabberd`,
            })
            .catch((error) => console.error(error));
    }

    private static decode(name: string | null | undefined) {
        if (!name) return "";
        return name
            .replace(/\\20/g, " ")
            .replace(/\\22/g, "*")
            .replace(/\\26/g, "&")
            .replace(/\\27/g, "'")
            .replace(/\\2f/g, "/")
            .replace(/\\3a/g, ":")
            .replace(/\\3c/g, "<")
            .replace(/\\3e/g, ">")
            .replace(/\\40/g, "@")
            .replace(/\\5c/g, "\\");
    }

    private static encode(name: string | null | undefined) {
        if (!name) return "";
        return name
            .replace(/\\/g, "\\5c")
            .replace(/ /g, "\\20")
            .replace(/\*/g, "\\22")
            .replace(/&/g, "\\26")
            .replace(/'/g, "\\27")
            .replace(/\//g, "\\2f")
            .replace(/:/g, "\\3a")
            .replace(/</g, "\\3c")
            .replace(/>/g, "\\3e")
            .replace(/@/g, "\\40");
    }
}
