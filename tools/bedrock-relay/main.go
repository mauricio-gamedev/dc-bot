package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/sandertv/mcwss"
)

type queuedCommand struct {
	ID          string `json:"id"`
	CommandLine string `json:"commandLine"`
	CreatedAt   string `json:"createdAt"`
}

type pullResponse struct {
	OK          bool           `json:"ok"`
	Mode        string         `json:"mode"`
	Command     *queuedCommand `json:"command"`
	PollAfterMS int            `json:"pollAfterMs"`
	Error       string         `json:"error"`
}

type playerState struct {
	mu     sync.RWMutex
	player *mcwss.Player
}

func (s *playerState) set(player *mcwss.Player) {
	s.mu.Lock()
	s.player = player
	s.mu.Unlock()
}

func (s *playerState) clear(player *mcwss.Player) {
	s.mu.Lock()
	if s.player == player {
		s.player = nil
	}
	s.mu.Unlock()
}

func (s *playerState) current() *mcwss.Player {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.player == nil || !s.player.Connected() {
		return nil
	}
	return s.player
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func pullURL(server, token string) string {
	return strings.TrimRight(server, "/") + "/minecraft-relay/" + url.PathEscape(token) + "/pull"
}

func pollCommands(state *playerState, server, token string) {
	client := &http.Client{Timeout: 8 * time.Second}
	endpoint := pullURL(server, token)
	interval := time.Second

	for {
		player := state.current()
		if player == nil {
			time.Sleep(600 * time.Millisecond)
			continue
		}

		request, err := http.NewRequest(http.MethodGet, endpoint, nil)
		if err != nil {
			log.Printf("relay: falha criando request: %v", err)
			time.Sleep(2 * time.Second)
			continue
		}
		request.Header.Set("User-Agent", "MiojoPlays-Bedrock-Relay/0.5.1")
		request.Header.Set("Accept", "application/json")

		response, err := client.Do(request)
		if err != nil {
			log.Printf("relay: bot inacessível: %v", err)
			time.Sleep(2 * time.Second)
			continue
		}

		var payload pullResponse
		decodeErr := json.NewDecoder(response.Body).Decode(&payload)
		response.Body.Close()

		if response.StatusCode == http.StatusUnauthorized {
			log.Printf("relay: chave recusada pelo bot. Gere/consulte uma chave nova com /game conectar.")
			time.Sleep(4 * time.Second)
			continue
		}
		if response.StatusCode != http.StatusOK {
			log.Printf("relay: bot respondeu HTTP %d", response.StatusCode)
			time.Sleep(2 * time.Second)
			continue
		}
		if decodeErr != nil {
			log.Printf("relay: resposta inválida do bot: %v", decodeErr)
			time.Sleep(2 * time.Second)
			continue
		}

		if payload.PollAfterMS >= 500 && payload.PollAfterMS <= 5000 {
			interval = time.Duration(payload.PollAfterMS) * time.Millisecond
		} else {
			interval = time.Second
		}

		if payload.Command != nil && payload.Command.CommandLine != "" {
			current := state.current()
			if current == nil {
				log.Printf("relay: comando %s descartado porque o Minecraft desconectou", payload.Command.ID)
			} else {
				log.Printf("relay: executando ação %s", payload.Command.ID)
				current.Exec(payload.Command.CommandLine, func(result map[string]interface{}) {
					if code, ok := result["statusCode"]; ok {
						log.Printf("relay: ação %s concluída (status=%v)", payload.Command.ID, code)
					} else {
						log.Printf("relay: ação %s concluída", payload.Command.ID)
					}
				})
			}
		}

		time.Sleep(interval)
	}
}

func main() {
	defaultServer := envOr("MIOJO_RELAY_SERVER", "https://dc-bot-us5v.onrender.com")
	defaultToken := strings.TrimSpace(os.Getenv("MIOJO_RELAY_TOKEN"))
	defaultListen := envOr("MIOJO_RELAY_LISTEN", "127.0.0.1:19131")

	serverFlag := flag.String("server", defaultServer, "URL HTTPS do bot MiojoPlays")
	tokenFlag := flag.String("token", defaultToken, "chave privada fornecida por /game conectar")
	listenFlag := flag.String("listen", defaultListen, "endereço local do WebSocket Bedrock")
	flag.Parse()

	serverURL := strings.TrimRight(strings.TrimSpace(*serverFlag), "/")
	token := strings.TrimSpace(*tokenFlag)
	listen := strings.TrimSpace(*listenFlag)

	if token == "" {
		log.Fatal("MIOJO_RELAY_TOKEN não configurado. Pegue a chave privada com /game conectar no Discord.")
	}
	parsed, err := url.Parse(serverURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		log.Fatal("MIOJO_RELAY_SERVER precisa ser uma URL HTTPS válida.")
	}
	if listen == "" {
		log.Fatal("endereço local inválido")
	}

	state := &playerState{}
	bedrock := mcwss.NewServer(&mcwss.Config{
		HandlerPattern: "/ws",
		Address:        listen,
	})

	bedrock.OnConnection(func(player *mcwss.Player) {
		state.set(player)
		name := strings.TrimSpace(player.Name())
		if name == "" {
			name = "jogador"
		}
		log.Printf("Minecraft conectado: %s", name)
		player.SendMessage("§d[MiojoPlays] §fRelay conectado ao Discord.")
	})

	bedrock.OnDisconnection(func(player *mcwss.Player) {
		state.clear(player)
		log.Printf("Minecraft desconectado do relay")
	})

	go pollCommands(state, serverURL, token)

	fmt.Println("MiojoPlays Bedrock Relay ativo ✅")
	fmt.Printf("Minecraft: /connect ws://%s/ws\n", listen)
	fmt.Println("Mantenha este Termux aberto enquanto usar o Game Interactive.")
	if err := bedrock.Run(); err != nil {
		log.Fatalf("relay encerrado: %v", err)
	}
}
