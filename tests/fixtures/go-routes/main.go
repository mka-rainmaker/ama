package main

import "github.com/gin-gonic/gin"

func listUsers(c *gin.Context)  {}
func getUser(c *gin.Context)    {}
func createUser(c *gin.Context) {}

func main() {
	r := gin.Default()
	r.GET("/users", listUsers)
	r.GET("/users/:id", getUser)
	r.POST("/users", createUser)
	r.Run()
}
